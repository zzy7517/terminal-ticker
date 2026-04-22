# Terminal Ticker

A small terminal price viewer for macOS and Linux. It reads a local watchlist, loads an initial Bitget snapshot over REST, then connects to Bitget public WebSocket ticker channels and renders a compact live dashboard with Textual.

## Features

- Live streaming quotes for a configured watchlist
- Compact terminal UI designed for a small terminal window
- Supports Bitget `USDT-FUTURES` instruments and can be extended to Spot if needed
- Auto reconnects after stream failures
- Local TOML config with no API key required

## Quick start

Create and activate the project environment:

```bash
cd /path/to/terminal-ticker
source .venv/bin/activate
```

Run the app with the default watchlist:

```bash
python -m terminal_ticker
```

Run with a custom config:

```bash
python -m terminal_ticker --config my-watchlist.toml
```

Run with an ad hoc symbol list:

```bash
python -m terminal_ticker --symbols USDT-FUTURES:MUUSDT USDT-FUTURES:MSFTUSDT USDT-FUTURES:BTCUSDT USDT-FUTURES:ETHUSDT USDT-FUTURES:XAUUSDT
```

## Config format

The default config file is [`watchlist.toml`](watchlist.toml).

```toml
title = "Terminal Ticker"
symbols = [
  { symbol = "MUUSDT", inst_type = "USDT-FUTURES", label = "MU" },
  { symbol = "MSFTUSDT", inst_type = "USDT-FUTURES", label = "MSFT" },
  { symbol = "BTCUSDT", inst_type = "USDT-FUTURES", label = "BTC" },
  { symbol = "ETHUSDT", inst_type = "USDT-FUTURES", label = "ETH" },
  { symbol = "XAUUSDT", inst_type = "USDT-FUTURES", label = "XAU" },
]

[display]
refresh_interval_ms = 1000
stale_after_seconds = 20
reconnect_delay_seconds = 3.0
```

Notes:

- This project now uses Bitget public market APIs only.
- Use explicit `inst_type` when a symbol exists in both Spot and Futures, for example `BTCUSDT`.
- The change columns are based on Bitget 24-hour ticker fields, not previous-session close.
- `refresh_interval_ms` controls UI heartbeat updates for stale timers, not the exchange feed cadence.

## Keyboard

- `q`: quit
- `r`: reconnect the stream

## Limitations

- This is a personal-use market monitor, not a production market data terminal.
- This app currently defaults to Bitget public USDT-Futures instruments. It does not yet connect to Bitget's separate CFD/MT5 stack.
- The app uses the local terminal window. It is not a native always-on-top macOS window.
