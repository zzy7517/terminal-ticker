# priceViewer

A small terminal price viewer for macOS and Linux. It reads a local watchlist, loads an initial Yahoo Finance snapshot, then connects to `yfinance` WebSocket streaming and renders a compact live dashboard with Textual.

## Features

- Live streaming quotes for a configured watchlist
- Compact terminal UI designed for a small terminal window
- Supports any Yahoo Finance symbol format that `yfinance` can stream
- Auto reconnects after stream failures
- Local TOML config with no API key required

## Quick start

Create and activate the project environment:

```bash
cd /Users/zhongyuanzhang/priceViewer
source .venv/bin/activate
```

Run the app with the default watchlist:

```bash
python -m priceviewer
```

Run with a custom config:

```bash
python -m priceviewer --config my-watchlist.toml
```

Run with an ad hoc symbol list:

```bash
python -m priceviewer --symbols AAPL NVDA BTC-USD GC=F ^GSPC
```

## Config format

The default config file is [watchlist.toml](/Users/zhongyuanzhang/priceViewer/watchlist.toml).

```toml
title = "Desk Quotes"
symbols = ["AAPL", "NVDA", "BTC-USD", "GC=F", "^GSPC"]

[display]
refresh_interval_ms = 1000
stale_after_seconds = 20
reconnect_delay_seconds = 3.0
```

Notes:

- Symbols must follow Yahoo Finance naming, for example `BTC-USD`, `GC=F`, `^GSPC`.
- `refresh_interval_ms` controls UI heartbeat updates for stale timers, not the market feed cadence.
- Stream availability depends on Yahoo Finance and `yfinance`.

## Keyboard

- `q`: quit
- `r`: reconnect the stream

## Limitations

- This is a personal-use market monitor, not a production market data terminal.
- Some symbols may be delayed or unavailable in Yahoo's stream.
- The app uses the local terminal window. It is not a native always-on-top macOS window.
