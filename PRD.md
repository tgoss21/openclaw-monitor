# Product Requirements Document: OpenClaw Market Monitor

## Overview

A standalone, lightweight market monitoring daemon that runs independently from OpenClaw with zero LLM involvement. It polls market data from Alpaca Markets (free tier, IEX real-time feed), calculates technical indicators locally, detects threshold breaches, generates candlestick chart images, and writes structured alerts to a shared folder that OpenClaw agents read.

This is **Project 1 of 2**. The OpenClaw agent system (Project 2) depends on the alerts and chart images this system produces. This project must be built, tested, and running before the agents are configured.

## Problem Statement

OpenClaw agents using LLM-powered heartbeats to poll market data every 15 minutes is expensive (~$10.87/month just for the Technicals agent). Most polling cycles find nothing actionable, wasting API tokens on empty checks.

## Solution

Move all market polling and threshold detection into a lightweight Node.js daemon that uses zero LLM tokens. The daemon only triggers agent involvement (via file-based alerts) when something meaningful happens — reducing monitoring costs from ~$10.87/month to ~$1.32-3.74/month.

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│  monitor.js (Node.js daemon)                            │
│  Polls Alpaca Markets every 5 min during market hours   │
│  Batch snapshot: ALL tickers in 1 API call              │
│  Calculates RSI, EMA, SMA locally (no LLM)             │
│  Checks thresholds, deduplicates alerts                 │
└──────────────────┬──────────────────────────────────────┘
                   │ threshold breached
                   ▼
┌─────────────────────────────────────────────────────────┐
│  chart-generator.py (Python/mplfinance)                 │
│  Renders 1200x800 candlestick PNG (~1,280 Claude tokens)│
│  Includes MA overlays (9 EMA, 21 EMA, 50 SMA, 200 SMA) │
└──────────────────┬──────────────────────────────────────┘
                   │ writes files
                   ▼
┌─────────────────────────────────────────────────────────┐
│  shared/                                                │
│  ├── alerts.md       → structured alerts (agents read)  │
│  ├── charts/*.png    → chart images (agents analyze)    │
│  └── watchlist.md    → active positions (agents write)  │
└─────────────────────────────────────────────────────────┘
```

## Functional Requirements

### FR-1: Market Data Polling
- Poll Alpaca Markets batch snapshot API for all watchlist tickers (single API call)
- Frequency: every 5 minutes during market hours (9:30 AM - 4:00 PM ET)
- Skip weekends and outside market hours
- Free tier: 200 API calls/min, IEX real-time feed

### FR-2: Local Technical Calculations
- **RSI(14):** Relative Strength Index, 14-period
- **EMA(9) and EMA(21):** Exponential moving averages
- **SMA(50) and SMA(200):** Simple moving averages
- All calculations performed locally in JavaScript — zero API or LLM calls

### FR-3: Threshold Detection
| Alert Type | Condition | Severity |
|-----------|-----------|----------|
| priceChange | Price moved > X% from previous close | MEDIUM (HIGH if >2x threshold) |
| volumeSpike | Volume > 2x 20-day average | MEDIUM (HIGH if >3x) |
| rsi | RSI crosses above 70 (overbought) or below 30 (oversold) | MEDIUM |
| maCross | 9/21 EMA crossover (bullish/bearish) | HIGH |
| maCross | 50/200 SMA golden cross or death cross | HIGH |
| nearStopLoss | Price within 2% of a position's stop loss | CRITICAL |
| nearTarget | Price within 2% of a position's target | HIGH |

### FR-4: Alert Deduplication
- Same ticker + alert type suppressed within a 30-minute window
- Maximum 3 alerts per ticker per scan cycle
- Alerts sorted by priority: nearStopLoss > nearTarget > maCross > volumeSpike > rsi > priceChange

### FR-5: Chart Generation
- Generate candlestick PNG via mplfinance when any threshold is breached
- Resolution: 1200x800 at 100 DPI (optimized for Claude vision at ~1,280 tokens)
- Include MA overlays: 9 EMA (orange), 21 EMA (blue), 50 SMA (purple), 200 SMA (black)
- Include volume bars with up/down coloring
- Intraday charts include VWAP overlay
- High-contrast style for LLM readability (white background, clear grid)

### FR-6: Alert File Output
- Append structured markdown alerts to `shared/alerts.md`
- Format must match the schema exactly (agents parse it)
- Include: severity, alert type, message, JSON data payload, chart path, status (PENDING)

### FR-7: Position Proximity Monitoring
- Read `shared/watchlist.md` for active positions with entry, stop, and target prices
- Fire CRITICAL alert when price is within 2% of stop loss
- Fire HIGH alert when price is within 2% of target

### FR-8: Historical Data Loading
- On startup, fetch 200 days of daily OHLCV history for all watchlist tickers
- Required for accurate RSI and moving average calculations
- Refresh history every 30 minutes during operation

## Non-Functional Requirements

### NFR-1: Zero LLM Cost
The monitoring daemon must never call any LLM API. All intelligence is rule-based.

### NFR-2: Reliability
- Must run as a persistent daemon via pm2 (production) or direct node (development)
- Auto-restart on crash
- Graceful handling of API errors, rate limits, and network failures

### NFR-3: Logging
- All activity logged to `monitor.log` with ISO timestamps
- Log levels: startup info, scan start/end, alerts fired, errors

### NFR-4: Configurability
- All thresholds, intervals, watchlist, and paths configurable via `config.json`
- API key stored in `.env` (never committed)

### NFR-5: Deployment
- Develop and test locally on macOS
- Deploy to Digital Ocean VPS (same machine as OpenClaw)
- `shared/` directory must be accessible by both monitor and OpenClaw agents

## Data API

**Alpaca Markets** (sole data source for the monitoring daemon — free tier)

| Endpoint | Purpose |
|----------|---------|
| `GET /v2/stocks/snapshots?symbols=AAPL,NVDA,...&feed=iex` | Batch real-time quotes, daily bars, previous close for ALL tickers in 1 call |
| `GET /v2/stocks/{ticker}/bars?timeframe=1Day&start=...&end=...` | Historical daily bars for RSI/MA calculations |

- Base URL: `https://data.alpaca.markets`
- Auth: headers `APCA-API-KEY-ID` and `APCA-API-SECRET-KEY`
- Free tier: 200 API calls/min, IEX real-time feed
- Data feed: `iex` (free) or `sip` (paid $99/mo — all exchanges)
- Cost: **$0/month** (free tier is sufficient for this monitor)

## Integration Points

### Output (this system writes):
- `shared/alerts.md` — structured alert entries with PENDING status
- `shared/charts/{TICKER}_latest.png` — candlestick chart images
- `shared/charts/{TICKER}_intraday.png` — intraday charts with VWAP

### Input (this system reads):
- `shared/watchlist.md` — active positions written by OpenClaw agents

### Consumer:
- OpenClaw Coordinator agent reads `shared/alerts.md` every 60 minutes
- OpenClaw Technicals agent reads chart images when processing alerts

## Tech Stack

| Component | Technology | Version |
|-----------|-----------|---------|
| Runtime | Node.js | 20+ |
| Chart engine | Python / mplfinance | 3.10+ / 0.12.10+ |
| Chart data | yfinance | 0.2.30+ |
| Market data API | Alpaca Markets (free tier, IEX feed) | v2 |
| Environment config | dotenv | 16.4+ |
| HTTP client | node-fetch | 3.3+ |
| Process manager | pm2 (production) | latest |

## Cost Impact

| Scenario | Monthly Cost |
|----------|-------------|
| Old (15-min LLM polling via heartbeat) | ~$10.87 |
| New (event-driven, no LLM) | ~$1.32-3.74 |
| **Savings** | **$7.13-9.55/month** |

The Alpaca free tier covers all monitoring needs at $0/month. Polygon.io ($29/month Starter) is only needed by the Options agent for options chain data — that cost belongs to the agent system, not the monitor.

## Success Criteria

1. Monitor runs continuously during market hours without crashes for 5+ consecutive trading days
2. Alerts fire correctly for all 7 threshold types when conditions are met
3. Chart images are readable and include all MA overlays
4. No duplicate alerts within the dedup window
5. Alert file format parseable by OpenClaw agents without modification
6. Total monitoring daemon cost: $0.00/month (zero LLM usage)

## Out of Scope

- LLM-based analysis (handled by OpenClaw agents in Project 2)
- Trade execution (this system is read-only / alert-only)
- Telegram notifications (handled by OpenClaw Coordinator agent)
- Fundamentals, sentiment, options, or flow data (handled by specialized agents)
- Historical backtesting
