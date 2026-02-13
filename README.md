# OpenClaw Market Monitor

A lightweight, event-driven market monitoring daemon that polls Alpaca Markets for real-time stock data, calculates technical indicators locally, and generates alerts + candlestick chart images for OpenClaw agents to consume.

**Zero LLM cost. Zero data API cost.** All logic is rule-based JavaScript and Python. Alpaca free tier provides real-time IEX quotes.

## Prerequisites

- **Node.js 20+** — [Download](https://nodejs.org/)
- **Python 3.10+** — [Download](https://python.org/)
- **Alpaca API keys** — [Sign up free](https://app.alpaca.markets/signup)

## Quick Start

```bash
# 1. Clone or navigate to the project
cd ~/Projects/openclaw-monitor

# 2. Install Node.js dependencies
npm install

# 3. Create Python virtual environment and install dependencies
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt

# 4. Configure your API keys
cp .env.example .env
# Edit .env and add your Alpaca APCA_API_KEY_ID and APCA_API_SECRET_KEY

# 5. (Optional) Edit config.json to customize your watchlist and thresholds

# 6. Test chart generation
./venv/bin/python3 chart-generator.py AAPL

# 7. Run a single test scan
node monitor.js --test

# 8. Run the monitor (continuous during market hours)
node monitor.js
```

## Project Structure

```
openclaw-monitor/
├── monitor.js              # Main daemon — polls Alpaca, calculates, detects, triggers charts
├── chart-generator.py      # Renders candlestick PNGs via mplfinance
├── config.json             # Watchlist, thresholds, schedule, API config, paths
├── package.json            # Node.js dependencies
├── requirements.txt        # Python dependencies
├── venv/                   # Python virtual environment (created during setup)
├── .env                    # API keys (create from .env.example, never commit)
├── .env.example            # Template for .env
├── .gitignore              # Ignores node_modules, .env, venv, charts, logs
├── monitor.log             # Runtime log (auto-created)
├── PRD.md                  # Product Requirements Document
├── README.md               # This file
└── shared/                 # Bridge to OpenClaw agents
    ├── alerts.md           # Monitor writes alert entries here
    ├── watchlist.md        # Agents write positions here, monitor reads
    └── charts/             # Chart PNG images
        ├── AAPL_latest.png
        └── ...
```

## Configuration

All settings are in `config.json`:

### Watchlist

```json
"watchlist": ["AAPL", "NVDA", "TSLA", "AMZN", "META", "GOOGL", "SPY", "QQQ"]
```

Add or remove tickers as needed. All tickers are fetched in a single batch API call per scan.

### API Settings

```json
"api": {
  "provider": "alpaca",
  "baseUrl": "https://data.alpaca.markets",
  "feed": "iex",
  "maxRequestsPerMinute": 200
}
```

- **feed: "iex"** — Free tier, real-time IEX exchange data
- **feed: "sip"** — Paid ($99/mo), all US exchanges

### Thresholds

| Setting | Default | Description |
|---------|---------|-------------|
| `priceChangePct` | 2.0 | Price change % from previous close to trigger alert |
| `volumeSpikeMultiplier` | 2.0 | Volume multiple of 20-day avg to trigger alert |
| `rsiOverbought` | 70 | RSI level for overbought alert |
| `rsiOversold` | 30 | RSI level for oversold alert |
| `nearStopLossPct` | 2.0 | Distance % from stop loss to trigger CRITICAL alert |
| `nearTargetPct` | 2.0 | Distance % from target to trigger alert |
| `maShortPeriod` | 9 | Short EMA period for crossover detection |
| `maLongPeriod` | 21 | Long EMA period for crossover detection |

**Tip for testing:** Lower `priceChangePct` to 0.5 and `volumeSpikeMultiplier` to 1.5 to see alerts fire more frequently.

### Schedule

```json
"schedule": {
  "checkIntervalMs": 300000,
  "marketOpen": "09:30",
  "marketClose": "16:00",
  "timezone": "America/New_York",
  "tradingDaysOnly": true
}
```

The monitor only scans during US market hours (Mon-Fri 9:30 AM - 4:00 PM ET). Outside these hours, it logs "Market closed — skipping scan" and waits.

### Paths

By default, all paths are relative to the project directory (`./`). When deploying to your VPS, update these to absolute paths matching your OpenClaw installation (e.g., `~/.openclaw/shared/alerts.md`).

## Usage

### Test Mode

Run a single scan cycle and exit. Useful for verifying your API keys work and alerts generate correctly:

```bash
node monitor.js --test
```

Test mode bypasses the market hours check so you can test anytime.

### Continuous Mode

Run the monitor as a long-lived process:

```bash
node monitor.js
```

It will scan every 5 minutes during market hours and sleep outside them.

### Chart Generation (standalone)

Generate a chart without running the full monitor:

```bash
# Daily chart (3 months)
./venv/bin/python3 chart-generator.py AAPL

# Custom period and interval
./venv/bin/python3 chart-generator.py NVDA 6mo 1d

# Intraday chart with VWAP (market hours only)
./venv/bin/python3 chart-generator.py TSLA --intraday

# Custom resolution
./venv/bin/python3 chart-generator.py SPY 3mo 1d 1600 1000
```

Charts are saved to `shared/charts/{TICKER}_latest.png`.

## Alert Format

When a threshold is breached, the monitor appends an alert to `shared/alerts.md`:

```markdown
## Alert: AAPL — 2026-02-12T14:35:00Z

- **[HIGH] volumeSpike:** AAPL volume at 2.8x average (48,200,000 vs avg 17,200,000)
  - Data: {"volume":48200000,"avgVolume":17200000,"multiple":2.8}
- **Chart:** ./shared/charts/AAPL_latest.png
- **Status:** PENDING

---
```

**Alert types:** `nearStopLoss` (CRITICAL), `nearTarget` (HIGH), `maCross` (HIGH), `volumeSpike` (MEDIUM/HIGH), `rsi` (MEDIUM), `priceChange` (MEDIUM/HIGH)

**Status flow:** `PENDING` → `PROCESSED` (Coordinator picks it up) → `RESOLVED` (action taken)

## Position Monitoring

To get stop-loss and target-price proximity alerts, add positions to `shared/watchlist.md`:

```markdown
# Active Watchlist

| Ticker | Entry | Stop | Target | Status |
|--------|-------|------|--------|--------|
| AAPL | 185.50 | 180.00 | 195.00 | active |
| NVDA | 890.00 | 860.00 | 950.00 | active |
```

The monitor checks active positions every scan cycle and fires CRITICAL alerts when price is within 2% of your stop loss.

## Deploying to VPS

Once tested locally, deploy to your Digital Ocean server where OpenClaw is running:

```bash
# 1. Push to a Git repo
git init && git add -A && git commit -m "Initial commit"
git remote add origin <your-repo-url>
git push -u origin main

# 2. On your VPS, clone into the OpenClaw directory
cd ~/.openclaw
git clone <your-repo-url> monitoring

# 3. Install dependencies on VPS
cd ~/.openclaw/monitoring
npm install
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt

# 4. Configure API keys
cp .env.example .env
nano .env  # add your APCA_API_KEY_ID and APCA_API_SECRET_KEY

# 5. Update paths in config.json to use absolute paths
# Change "./shared/" to "~/.openclaw/shared/" (or create a symlink)

# 6. Start as a persistent daemon
pm2 start monitor.js --name openclaw-monitor
pm2 save
pm2 startup  # auto-start on reboot

# 7. Verify
pm2 status
pm2 logs openclaw-monitor
```

### Linking shared/ on VPS

The `shared/` directory must be accessible to both the monitor and OpenClaw agents. Two options:

**Option A: Symlink (recommended)**
```bash
ln -s ~/.openclaw/shared ~/.openclaw/monitoring/shared
```

**Option B: Update config.json paths**
```json
"paths": {
  "alertFile": "~/.openclaw/shared/alerts.md",
  "watchlistFile": "~/.openclaw/shared/watchlist.md",
  "chartOutputDir": "~/.openclaw/shared/charts/",
  "chartGenerator": "~/.openclaw/monitoring/chart-generator.py",
  "logFile": "~/.openclaw/monitoring/monitor.log"
}
```

## Troubleshooting

| Problem | Cause | Fix |
|---------|-------|-----|
| `Alpaca API keys not set` | Missing .env file | `cp .env.example .env` and add your keys |
| `Alpaca snapshot failed (403)` | Invalid API keys | Check keys at https://app.alpaca.markets |
| `No snapshot data for TICKER` | Ticker not on IEX | Verify ticker; try SPY or AAPL first |
| `Chart generation failed` | Python deps missing | Run `source venv/bin/activate && pip install -r requirements.txt` |
| No alerts firing | Thresholds too strict | Lower `priceChangePct` to 0.5 for testing |
| Too many alerts | Thresholds too loose | Raise values; reduce `maxAlertsPerTicker` |
| Duplicate alerts | Dedup window too short | Increase `dedupeWindowMs` in config.json |
| Monitor stops after reboot | pm2 not saved | Run `pm2 startup` and `pm2 save` |
| Charts look empty | yfinance data issue | Check internet; try `./venv/bin/python3 chart-generator.py SPY` |

## Logs

The monitor writes timestamped logs to `monitor.log`:

```bash
# Watch logs in real-time
tail -f monitor.log

# Or via pm2 (on VPS)
pm2 logs openclaw-monitor
```

## Related

- **OpenClaw Agent System** — see `openclaw-stock-agents-project-optimized.md` in Downloads
- **Monitoring System Spec** — see `openclaw-monitoring-system.md` in Downloads
