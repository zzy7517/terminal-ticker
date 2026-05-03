# Implementation Plan: Price Action Web UI

**Branch**: `main` | **Date**: 2026-04-28 | **Spec**: [spec.md](spec.md)
**Input**: User request: remove all PySide, collapsed ticker, and scrolling ticker logic; rebuild the product as a Web UI.

## Summary

Replace the PySide floating desktop UI with a local Web UI. Python remains responsible for Bitget/Longbridge market data, OHLCV candle normalization, and deterministic price action analysis. A FastAPI app exposes current state over REST and pushes live snapshots over WebSocket. A Vite/React frontend renders a dense trading workspace with watchlist, K-line chart, and agent explanation panel.

## Technical Context

**Language/Version**: Python 3.x in the existing virtual environment; TypeScript/React through Vite
**Primary Dependencies**: FastAPI, uvicorn, websockets, longbridge, React, Lightweight Charts, lucide-react
**Storage**: Existing TOML config plus local SQLite cache for per-instrument Agent sessions
**Testing**: `unittest` via `.venv/bin/python -m unittest discover -s tests`; frontend build via `npm run build`
**Target Platform**: Local browser UI served from the Python process, with Vite dev server during development
**Project Type**: local web app
**Performance Goals**: Provider feeds must not block HTTP/WebSocket handling; WebSocket snapshots stay watchlist-sized; chart rendering is delegated to Lightweight Charts.
**Constraints**: No backend cloud service, no new market data credential requirement, no automatic trading, no screenshot chart recognition, no PySide/Qt runtime.
**Scale/Scope**: Existing watchlist-sized local monitoring for Bitget instruments and configured Longbridge instruments.

## Constitution Check

- Preserve local-first scope: PASS. Runs as a local FastAPI server and browser UI.
- Improve UI surface for chart work: PASS. Uses a real Web charting library instead of custom Qt painting.
- Protect feed integrity: PASS. Missing, too few, failed, or stale candles map to unavailable analysis.
- Remove obsolete desktop behavior: PASS. PySide, collapsed ticker, and scrolling ticker UI are removed.
- Define automated verification: PASS. Python unit suite and frontend production build are required.

## Project Structure

### Source Code

```text
terminal_ticker/
├── bitget.py              # Bitget quote/candle fetch and normalization
├── config.py              # Watchlist and analysis settings
├── controller.py          # Applies feed events to quote state
├── feed.py                # Provider background workers
├── longbridge_provider.py # Longbridge quote/search/candle integration
├── models.py              # Quote state and display labels
├── price_action.py        # Provider-neutral deterministic analyzer
├── web.py                 # FastAPI app, REST, WebSocket, runtime state
└── __main__.py            # Web server CLI entry point

web/
├── index.html
├── tsconfig.json
└── src/
    ├── App.tsx
    ├── api.ts
    ├── main.tsx
    ├── styles.css
    └── types.ts

tests/
├── test_web.py
├── test_bitget.py
├── test_config.py
├── test_controller.py
├── test_feed.py
├── test_longbridge_provider.py
├── test_models.py
├── test_price_action.py
└── test_watchlist_store.py
```

**Structure Decision**: Keep market data and analysis logic in Python, because those modules are already tested and provider-aware. Move all presentation and chart interaction to the browser, where mature charting and layout tools are available.

## Complexity Tracking

This is a product-shape migration touching more than eight files and introducing one local web service surface plus a frontend package. It is still reversible because no persistent data format changes are required.

## Implementation Approach

1. Remove PySide runtime files, Qt dependencies, and Qt widget tests.
2. Add `terminal_ticker.web` with FastAPI REST, WebSocket broadcast, state serialization, and Longbridge watchlist search/add/remove endpoints.
3. Replace the CLI entry point with a local web server runner.
4. Add Vite/React frontend using Lightweight Charts for K-line rendering.
5. Update README and feature docs to describe Web UI behavior instead of floating/collapsed desktop behavior.
6. Verify with Python unit tests, frontend build, and browser smoke testing.
