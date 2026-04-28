# Quickstart: Price Action Web UI

## Install

```bash
cd /Users/zhongyuanzhang/priceViewer
source .venv/bin/activate
pip install -r requirements.txt
npm install
```

## Run Tests

```bash
.venv/bin/python -m unittest discover -s tests
npm run build
```

## Run Locally

Terminal 1:

```bash
.venv/bin/python -m terminal_ticker --host 127.0.0.1 --port 8765
```

Terminal 2:

```bash
npm run dev
```

Open:

```text
http://127.0.0.1:5173
```

Expected behavior:

- The browser UI shows grouped watchlist rows.
- Selecting a row updates the K-line chart and agent explanation.
- Supported Bitget and Longbridge symbols show price action markers after candle analysis is available.
- Longbridge symbols fall back to quote-only if credentials, market data permission, or candle access are unavailable.
- If candle fetch fails, quote display remains usable and analysis is omitted or marked unavailable.

## Production Static Build

```bash
npm run build
.venv/bin/python -m terminal_ticker --host 127.0.0.1 --port 8765
```

Open:

```text
http://127.0.0.1:8765
```
