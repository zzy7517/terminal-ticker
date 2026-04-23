# Terminal Ticker

A compact floating ticker for macOS and Linux. It reads a local watchlist, loads an initial Bitget snapshot over REST, then connects to Bitget public WebSocket ticker channels and renders a small always-on-top window.

## Features

- Live streaming quotes for a configured watchlist
- Frameless always-on-top floating window designed for a small corner of your screen
- Shows only symbol names and live prices in a very small floating window
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
- `refresh_interval_ms` controls UI heartbeat updates for stale timers, not the exchange feed cadence.
- The floating UI intentionally keeps only symbol and price. Everything else was removed to minimize footprint.

## Interaction

- Drag anywhere on the window to move it
- Click `×` to close

## Limitations

- This is a personal-use market monitor, not a production market data terminal.
- This app currently defaults to Bitget public USDT-Futures instruments. It does not yet connect to Bitget's separate CFD/MT5 stack.
- The floating window is native Qt, not a Swift/AppKit macOS app.
