require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// ─── Config ──────────────────────────────────────────────────────
const config = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf-8'));
const resolvePath = (p) => p.startsWith('./') ? path.join(__dirname, p) : p.replace('~', process.env.HOME);
const ALERT_FILE = resolvePath(config.paths.alertFile);
const WATCHLIST_FILE = resolvePath(config.paths.watchlistFile);
const CHART_DIR = resolvePath(config.paths.chartOutputDir);
const CHART_GEN = resolvePath(config.paths.chartGenerator);
const LOG_FILE = resolvePath(config.paths.logFile);
const API_KEY_ID = process.env.APCA_API_KEY_ID;
const API_SECRET = process.env.APCA_API_SECRET_KEY;
const API_BASE = config.api.baseUrl;
const API_FEED = config.api.feed;
const IS_TEST = process.argv.includes('--test');

// ─── State ───────────────────────────────────────────────────────
const priceHistory = {};     // { ticker: [close, close, ...] } for RSI/MA
const avgVolume = {};        // { ticker: 20-day average volume }
const recentAlerts = {};     // { "AAPL:volumeSpike": timestamp } for dedup

// ─── Logging ─────────────────────────────────────────────────────
function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  fs.appendFileSync(LOG_FILE, line + '\n');
}

// ─── Alpaca API helpers ─────────────────────────────────────────
function alpacaHeaders() {
  return {
    'APCA-API-KEY-ID': API_KEY_ID,
    'APCA-API-SECRET-KEY': API_SECRET,
  };
}

// ─── Market hours check ─────────────────────────────────────────
function isMarketOpen() {
  if (IS_TEST) return true;
  const now = new Date();
  const day = now.getDay();
  if (day === 0 || day === 6) return false;
  const et = new Date(now.toLocaleString('en-US', { timeZone: config.schedule.timezone }));
  const time = et.getHours() * 60 + et.getMinutes();
  const [openH, openM] = config.schedule.marketOpen.split(':').map(Number);
  const [closeH, closeM] = config.schedule.marketClose.split(':').map(Number);
  return time >= (openH * 60 + openM) && time <= (closeH * 60 + closeM);
}

// ─── Alpaca Market Data API ─────────────────────────────────────
// Batch snapshot: fetches ALL tickers in a single API call
async function fetchSnapshots(tickers) {
  const fetch = (await import('node-fetch')).default;
  const symbols = tickers.join(',');
  const url = `${API_BASE}/v2/stocks/snapshots?symbols=${symbols}&feed=${API_FEED}`;
  const res = await fetch(url, { headers: alpacaHeaders() });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Alpaca snapshot failed (${res.status}): ${body}`);
  }
  const data = await res.json();

  const quotes = {};
  for (const ticker of tickers) {
    const snap = data[ticker];
    if (!snap) { log(`No snapshot data for ${ticker}`); continue; }
    const daily = snap.dailyBar || {};
    const prev = snap.prevDailyBar || {};
    const trade = snap.latestTrade || {};
    const price = trade.p || daily.c;
    const prevClose = prev.c;
    const changePct = prevClose ? ((price - prevClose) / prevClose) * 100 : null;
    quotes[ticker] = {
      price,
      open: daily.o,
      high: daily.h,
      low: daily.l,
      volume: daily.v,
      prevClose,
      changePct,
      vwap: daily.vw,
      timestamp: Date.now()
    };
  }
  return quotes;
}

// Fetch historical daily bars for a single ticker
async function fetchHistory(ticker) {
  const fetch = (await import('node-fetch')).default;
  const end = new Date().toISOString().split('T')[0];
  const start = new Date(Date.now() - 300 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
  const url = `${API_BASE}/v2/stocks/${ticker}/bars?timeframe=1Day&start=${start}&end=${end}&limit=10000&adjustment=split&sort=asc&feed=${API_FEED}`;
  const res = await fetch(url, { headers: alpacaHeaders() });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Alpaca bars failed for ${ticker} (${res.status}): ${body}`);
  }
  const data = await res.json();
  if (data.bars && data.bars.length > 0) {
    priceHistory[ticker] = data.bars.map(b => b.c);
    const volumes = data.bars.map(b => b.v).slice(-20);
    avgVolume[ticker] = volumes.reduce((a, b) => a + b, 0) / volumes.length;
  }
}

// ─── Technical calculations (local, zero LLM) ──────────────────
function calcRSI(closes, period = 14) {
  if (closes.length < period + 1) return null;
  const recent = closes.slice(-(period + 1));
  let gains = 0, losses = 0;
  for (let i = 1; i < recent.length; i++) {
    const diff = recent[i] - recent[i - 1];
    if (diff > 0) gains += diff; else losses += Math.abs(diff);
  }
  if (losses === 0) return 100;
  const rs = (gains / period) / (losses / period);
  return 100 - (100 / (1 + rs));
}

function calcEMA(closes, period) {
  if (closes.length < period) return null;
  const k = 2 / (period + 1);
  let ema = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < closes.length; i++) ema = closes[i] * k + ema * (1 - k);
  return ema;
}

function calcSMA(closes, period) {
  if (closes.length < period) return null;
  return closes.slice(-period).reduce((a, b) => a + b, 0) / period;
}

// ─── Threshold checks ───────────────────────────────────────────
function checkThresholds(ticker, quote) {
  const alerts = [];
  const t = config.thresholds;
  const history = priceHistory[ticker] || [];

  // Price change from previous close
  if (quote.changePct && Math.abs(quote.changePct) >= t.priceChangePct) {
    alerts.push({
      type: 'priceChange',
      message: `${ticker} moved ${quote.changePct > 0 ? '+' : ''}${quote.changePct.toFixed(2)}% from previous close`,
      severity: Math.abs(quote.changePct) >= t.priceChangePct * 2 ? 'HIGH' : 'MEDIUM',
      data: { changePct: quote.changePct.toFixed(2), price: quote.price, prevClose: quote.prevClose }
    });
  }

  // Volume spike
  if (avgVolume[ticker] && quote.volume > avgVolume[ticker] * t.volumeSpikeMultiplier) {
    const multiple = (quote.volume / avgVolume[ticker]).toFixed(1);
    alerts.push({
      type: 'volumeSpike',
      message: `${ticker} volume at ${multiple}x average (${quote.volume.toLocaleString()} vs avg ${Math.round(avgVolume[ticker]).toLocaleString()})`,
      severity: parseFloat(multiple) >= 3.0 ? 'HIGH' : 'MEDIUM',
      data: { volume: quote.volume, avgVolume: Math.round(avgVolume[ticker]), multiple: parseFloat(multiple) }
    });
  }

  // RSI
  const rsi = calcRSI(history);
  if (rsi !== null) {
    if (rsi >= t.rsiOverbought) {
      alerts.push({ type: 'rsi', message: `${ticker} RSI(14) overbought at ${rsi.toFixed(1)}`, severity: 'MEDIUM', data: { rsi: rsi.toFixed(1), condition: 'overbought' } });
    } else if (rsi <= t.rsiOversold) {
      alerts.push({ type: 'rsi', message: `${ticker} RSI(14) oversold at ${rsi.toFixed(1)}`, severity: 'MEDIUM', data: { rsi: rsi.toFixed(1), condition: 'oversold' } });
    }
  }

  // EMA crossovers (9/21)
  const emaS = calcEMA(history, t.maShortPeriod);
  const emaL = calcEMA(history, t.maLongPeriod);
  const prevEmaS = calcEMA(history.slice(0, -1), t.maShortPeriod);
  const prevEmaL = calcEMA(history.slice(0, -1), t.maLongPeriod);
  if (emaS && emaL && prevEmaS && prevEmaL) {
    if (prevEmaS <= prevEmaL && emaS > emaL) {
      alerts.push({ type: 'maCross', message: `${ticker} bullish ${t.maShortPeriod}/${t.maLongPeriod} EMA crossover`, severity: 'HIGH', data: { crossType: 'bullish', shortMA: emaS.toFixed(2), longMA: emaL.toFixed(2) } });
    } else if (prevEmaS >= prevEmaL && emaS < emaL) {
      alerts.push({ type: 'maCross', message: `${ticker} bearish ${t.maShortPeriod}/${t.maLongPeriod} EMA crossover`, severity: 'HIGH', data: { crossType: 'bearish', shortMA: emaS.toFixed(2), longMA: emaL.toFixed(2) } });
    }
  }

  // Golden cross / Death cross (50/200 SMA)
  const sma50 = calcSMA(history, t.goldenDeathCrossShort);
  const sma200 = calcSMA(history, t.goldenDeathCrossLong);
  const prevSma50 = calcSMA(history.slice(0, -1), t.goldenDeathCrossShort);
  const prevSma200 = calcSMA(history.slice(0, -1), t.goldenDeathCrossLong);
  if (sma50 && sma200 && prevSma50 && prevSma200) {
    if (prevSma50 <= prevSma200 && sma50 > sma200) {
      alerts.push({ type: 'maCross', message: `${ticker} GOLDEN CROSS — 50 SMA crossed above 200 SMA`, severity: 'HIGH', data: { crossType: 'golden', sma50: sma50.toFixed(2), sma200: sma200.toFixed(2) } });
    } else if (prevSma50 >= prevSma200 && sma50 < sma200) {
      alerts.push({ type: 'maCross', message: `${ticker} DEATH CROSS — 50 SMA crossed below 200 SMA`, severity: 'HIGH', data: { crossType: 'death', sma50: sma50.toFixed(2), sma200: sma200.toFixed(2) } });
    }
  }

  return alerts;
}

// ─── Position proximity checks ──────────────────────────────────
function checkPositions(ticker, quote) {
  const alerts = [];
  const t = config.thresholds;
  if (!fs.existsSync(WATCHLIST_FILE)) return alerts;

  const lines = fs.readFileSync(WATCHLIST_FILE, 'utf-8').split('\n');
  for (const line of lines) {
    if (!line.includes(ticker) || !line.includes('|')) continue;
    const cols = line.split('|').map(c => c.trim()).filter(Boolean);
    if (cols.length < 5 || cols[0] !== ticker) continue;

    const stopLoss = parseFloat(cols[2]);
    const target = parseFloat(cols[3]);
    const status = cols[4]?.toLowerCase();
    if (status !== 'active') continue;

    if (stopLoss && !isNaN(stopLoss)) {
      const dist = ((quote.price - stopLoss) / quote.price) * 100;
      if (Math.abs(dist) <= t.nearStopLossPct) {
        alerts.push({ type: 'nearStopLoss', message: `${ticker} is ${dist.toFixed(1)}% from stop loss ($${stopLoss})`, severity: 'CRITICAL', data: { price: quote.price, stopLoss, distancePct: dist.toFixed(1) } });
      }
    }
    if (target && !isNaN(target)) {
      const dist = ((target - quote.price) / quote.price) * 100;
      if (Math.abs(dist) <= t.nearTargetPct) {
        alerts.push({ type: 'nearTarget', message: `${ticker} is ${dist.toFixed(1)}% from target ($${target})`, severity: 'HIGH', data: { price: quote.price, target, distancePct: dist.toFixed(1) } });
      }
    }
  }
  return alerts;
}

// ─── Deduplication ──────────────────────────────────────────────
function isDuplicate(ticker, alertType) {
  const key = `${ticker}:${alertType}`;
  const last = recentAlerts[key];
  if (last && (Date.now() - last) < config.alerts.dedupeWindowMs) return true;
  recentAlerts[key] = Date.now();
  return false;
}

// ─── Chart generation ───────────────────────────────────────────
function generateChart(ticker, alertType) {
  try {
    const pythonBin = path.join(__dirname, 'venv', 'bin', 'python3');
    const python = fs.existsSync(pythonBin) ? pythonBin : 'python3';
    if (alertType) {
      // Alert-driven mode: chart-generator.py auto-selects best timeframe
      execSync(`"${python}" "${CHART_GEN}" ${ticker} ${alertType}`, { timeout: 30000 });
    } else {
      // Fallback: use config defaults for manual/non-alert charts
      const { period, interval, width, height } = config.chartDefaults;
      execSync(`"${python}" "${CHART_GEN}" ${ticker} ${period} ${interval} ${width} ${height}`, { timeout: 30000 });
    }
    const chartPath = path.join(CHART_DIR, `${ticker}_latest.png`);
    if (fs.existsSync(chartPath)) { log(`Chart generated: ${chartPath}`); return chartPath; }
  } catch (err) { log(`Chart generation failed for ${ticker}: ${err.message}`); }
  return null;
}

// ─── Write alerts ───────────────────────────────────────────────
function writeAlerts(ticker, alerts, chartPath) {
  const timestamp = new Date().toISOString();
  let block = `\n## Alert: ${ticker} — ${timestamp}\n\n`;
  for (const alert of alerts) {
    block += `- **[${alert.severity}] ${alert.type}:** ${alert.message}\n`;
    block += `  - Data: ${JSON.stringify(alert.data)}\n`;
  }
  if (chartPath) block += `- **Chart:** ${chartPath}\n`;
  block += `- **Status:** PENDING\n\n---\n`;
  fs.appendFileSync(ALERT_FILE, block);
  log(`Wrote ${alerts.length} alert(s) for ${ticker}`);
}

// ─── Main scan ──────────────────────────────────────────────────
async function scan() {
  if (!isMarketOpen()) { log('Market closed — skipping scan'); return; }
  log(`Scanning ${config.watchlist.length} tickers...`);

  try {
    // Single API call fetches all tickers at once
    const quotes = await fetchSnapshots(config.watchlist);

    for (const ticker of config.watchlist) {
      try {
        const quote = quotes[ticker];
        if (!quote) continue;

        // Refresh history every 30 min for accurate RSI/MA
        if (!priceHistory[ticker] || (Date.now() - (priceHistory[ticker]._lastFetch || 0)) > 1800000) {
          await fetchHistory(ticker);
          if (priceHistory[ticker]) priceHistory[ticker]._lastFetch = Date.now();
        }
        if (priceHistory[ticker]) priceHistory[ticker].push(quote.price);

        const allAlerts = [...checkPositions(ticker, quote), ...checkThresholds(ticker, quote)]
          .filter(a => !isDuplicate(ticker, a.type))
          .sort((a, b) => config.alerts.priorityOrder.indexOf(a.type) - config.alerts.priorityOrder.indexOf(b.type))
          .slice(0, config.alerts.maxAlertsPerTicker);

        if (allAlerts.length > 0) {
          // Pass highest-priority alert type for optimal chart timeframe
          const chartPath = generateChart(ticker, allAlerts[0].type);
          writeAlerts(ticker, allAlerts, chartPath);
        }
      } catch (err) { log(`Error processing ${ticker}: ${err.message}`); }
    }
  } catch (err) { log(`Snapshot fetch failed: ${err.message}`); }
  log('Scan complete');
}

// ─── Startup ────────────────────────────────────────────────────
(async () => {
  if (!API_KEY_ID || !API_SECRET) {
    log('ERROR: Alpaca API keys not set. Copy .env.example to .env and add APCA_API_KEY_ID and APCA_API_SECRET_KEY.');
    process.exit(1);
  }
  if (!fs.existsSync(CHART_DIR)) fs.mkdirSync(CHART_DIR, { recursive: true });

  log('OpenClaw Market Monitor starting...');
  log(`Watchlist: ${config.watchlist.join(', ')}`);
  log(`Interval: ${config.schedule.checkIntervalMs / 1000}s | API: Alpaca (${API_FEED} feed)`);

  // Load historical data for RSI/MA calculations
  for (const ticker of config.watchlist) {
    try { await fetchHistory(ticker); log(`Loaded history for ${ticker} (${priceHistory[ticker]?.length || 0} points)`); }
    catch (err) { log(`Failed to load history for ${ticker}: ${err.message}`); }
  }

  await scan();
  if (IS_TEST) { log('Test complete. Exiting.'); process.exit(0); }
  setInterval(scan, config.schedule.checkIntervalMs);
})();
