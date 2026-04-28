# Quickstart: Price Action Agent

## Run Tests

```bash
cd /Users/zhongyuanzhang/priceViewer
.venv/bin/python -m unittest discover -s tests
```

## Try Locally

Use the existing watchlist and launch the app:

```bash
cd /Users/zhongyuanzhang/priceViewer
.venv/bin/python -m terminal_ticker
```

Expected behavior:

- Bitget symbols continue to show live prices.
- Supported Bitget symbols show compact price action markers after candle analysis is available.
- Longbridge symbols remain quote-only.
- If candle fetch fails, quote display remains usable and analysis is omitted or marked unavailable.
