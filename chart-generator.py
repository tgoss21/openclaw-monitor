"""
Generates candlestick chart images from OHLCV data using mplfinance.
Called by monitor.js when a threshold alert fires.

Optimized for Claude vision analysis:
- Clean candlesticks + volume only (no indicator overlays — numeric data is in the alert)
- High contrast colors on white background
- Large readable title with ticker, price, timeframe, date
- Timeframe auto-selected based on alert type for maximum relevance
- 1200x800 at 100 DPI (~1,280 tokens per image)

Usage:
  python3 chart-generator.py TICKER ALERT_TYPE
  python3 chart-generator.py AAPL nearStopLoss
  python3 chart-generator.py TSLA maCross
  python3 chart-generator.py NVDA 3mo 1d          # manual override
"""

import mplfinance as mpf
import matplotlib.pyplot as plt
import yfinance as yf
import sys
import os
from datetime import datetime

CHART_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'shared', 'charts')

# Alert type → best chart timeframe mapping
# Format: { alertType: (period, interval, description) }
ALERT_TIMEFRAMES = {
    'nearStopLoss': ('1d', '5m', 'Precise recent action — need to act now'),
    'nearTarget':   ('1d', '5m', 'Precise recent action — approaching target'),
    'maCross':      ('3mo', '1d', 'Trend context to confirm crossover'),
    'volumeSpike':  ('5d', '1h', 'Spike relative to recent sessions'),
    'rsi':          ('3mo', '1d', 'Broader context for RSI extremes'),
    'priceChange':  ('1d', '15m', 'Intraday move structure'),
}
DEFAULT_TIMEFRAME = ('3mo', '1d', 'Default daily chart')

# High-contrast style optimized for LLM visual pattern recognition
LLM_STYLE = mpf.make_mpf_style(
    base_mpf_style='charles',
    marketcolors=mpf.make_marketcolors(
        up='#26a69a', down='#ef5350', edge='inherit', wick='inherit',
        volume={'up': '#26a69a', 'down': '#ef5350'},
    ),
    figcolor='white', gridcolor='#e0e0e0', gridstyle='--',
    gridaxis='both', facecolor='white',
    rc={'font.size': 12, 'axes.titlesize': 15, 'axes.labelsize': 12}
)


def generate_chart(ticker, period='3mo', interval='1d', width=1200, height=800):
    data = yf.download(ticker, period=period, interval=interval, progress=False)
    if data.empty:
        print(f'ERROR: No data for {ticker}', file=sys.stderr)
        return None

    # Flatten MultiIndex columns if present (yfinance >= 0.2.30)
    if hasattr(data.columns, 'levels') and len(data.columns.levels) > 1:
        data.columns = data.columns.get_level_values(0)

    last_price = data['Close'].iloc[-1]
    last_date = data.index[-1].strftime('%Y-%m-%d')
    title = f'{ticker}  |  ${last_price:.2f}  |  {interval}  |  {last_date}'

    dpi = 100
    figsize = (width / dpi, height / dpi)
    os.makedirs(CHART_DIR, exist_ok=True)
    save_path = os.path.join(CHART_DIR, f'{ticker}_latest.png')

    fig, axes = mpf.plot(
        data, type='candle', style=LLM_STYLE, volume=True,
        title=title, figsize=figsize, returnfig=True,
        tight_layout=True, warn_too_much_data=1000,
    )

    fig.savefig(save_path, dpi=dpi, bbox_inches='tight', pad_inches=0.3)
    plt.close(fig)

    if os.path.exists(save_path):
        size_kb = os.path.getsize(save_path) / 1024
        print(f'Chart saved: {save_path} ({size_kb:.0f} KB)')
        return save_path
    return None


if __name__ == '__main__':
    if len(sys.argv) < 2:
        print('Usage: python3 chart-generator.py TICKER ALERT_TYPE')
        print('       python3 chart-generator.py TICKER PERIOD INTERVAL [WIDTH] [HEIGHT]')
        print()
        print('Alert types: nearStopLoss, nearTarget, maCross, volumeSpike, rsi, priceChange')
        sys.exit(1)

    ticker = sys.argv[1].upper()

    if len(sys.argv) == 3 and sys.argv[2] in ALERT_TIMEFRAMES:
        # Alert-driven mode: auto-select timeframe
        alert_type = sys.argv[2]
        period, interval, reason = ALERT_TIMEFRAMES[alert_type]
        print(f'Alert: {alert_type} → {period}/{interval} ({reason})')
        generate_chart(ticker, period, interval)
    elif len(sys.argv) >= 4:
        # Manual override mode
        period = sys.argv[2]
        interval = sys.argv[3]
        width = int(sys.argv[4]) if len(sys.argv) > 4 else 1200
        height = int(sys.argv[5]) if len(sys.argv) > 5 else 800
        generate_chart(ticker, period, interval, width, height)
    else:
        # Default
        period, interval, _ = DEFAULT_TIMEFRAME
        generate_chart(ticker, period, interval)
