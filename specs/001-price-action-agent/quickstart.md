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
- Supported Bitget and Longbridge symbols show compact price action markers after candle analysis is available.
- Clicking a row in expanded mode shows the selected symbol's state, reason, and recent K-line preview.
- Longbridge symbols fall back to quote-only if credentials, market data permission, or candle access are unavailable.
- If candle fetch fails, quote display remains usable and analysis is omitted or marked unavailable.
