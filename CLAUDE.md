# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

All commands assume the repo's virtualenv at `.venv` (already present). Python code lives under `mytradebot/`; the frontend lives under `web/`.

### Running the app

Dev mode needs two terminals:

```bash
# Terminal 1 — backend (FastAPI + uvicorn on :8765)
.venv/bin/python -m mytradebot --host 127.0.0.1 --port 8765

# Terminal 2 — Vite dev server on :5173 (proxies /api and /ws to :8765)
npm run dev
```

Single-process mode (backend serves the built frontend on :8765):

```bash
npm run build
.venv/bin/python -m mytradebot --host 127.0.0.1 --port 8765
```

CLI overrides: `--config my.toml`, `--symbols USDT-FUTURES:BTCUSDT ...`, `--log-level DEBUG`.

### Tests

```bash
# Full Python suite (uses pytest config in pytest.ini: pythonpath=.)
.venv/bin/python -m pytest

# Single test file
.venv/bin/python -m pytest tests/test_feed.py

# Single test
.venv/bin/python -m pytest tests/test_feed.py::test_name

# Unittest runner also works (tests use unittest.TestCase)
.venv/bin/python -m unittest discover -s tests

# Frontend type-check + build (no separate lint task)
npm run build
```

### Required environment

Codex provider reads `$CODEX_HOME/auth.json` (default `~/.codex/auth.json`), or `MYTRADEBOT_CODEX_API_KEY` env var.

Bitget Demo Trading uses demo-only API credentials. The backend signs v2 REST requests and always sends `paptrading: 1`:

```bash
export BITGET_DEMO_API_KEY=...
export BITGET_DEMO_API_SECRET=...
export BITGET_DEMO_PASSPHRASE=...
```

## Architecture

This is a local-first market monitoring and LLM research tool. One Python process runs a FastAPI server that owns all market state; a React/Vite frontend talks to it over REST + a single WebSocket.

### Layering (read in this order if new to the codebase)

The Python package `mytradebot/` is organized as strict layers. Upper layers import lower layers, never the reverse:

1. **`domain/`** — pure dataclasses. `Candle` (OHLCV, self-validating), `QuoteState`, `merge_candles`. No I/O.
2. **`config/`** — parses `watchlist.toml` → `AppConfig`. Also holds agent model normalization (`agent_models.py`) and `watchlist_store.py` which round-trips the TOML on add/remove from the UI.
3. **`market_data/`** — per-provider adapters (`bitget.py`, `hyperliquid.py`) plus `router.py` which dispatches `InstrumentConfig` to the right provider and preserves watchlist order. `candle_cache.py` provides the local OHLCV cache that agent tools read from.
4. **`runtime/`** — `feed.py` runs a background worker that streams quotes/candles from providers into a `queue.Queue` of `FeedEvent`s. `controller.py` (`TickerController`) drains that queue into an in-memory `QuoteState` map and tracks flash directions.
5. **`trading/`** — local trade records and external live/demo execution. `store.py` is a SQLite-backed `TradeStore` at `~/.cache/mytradebot/trades.sqlite3` (tables: trades, fills, snapshots, lessons). `hyperliquid.py` submits signed Hyperliquid mainnet orders when `[trading].hyperliquid_enabled` is true; `bitget_demo.py` signs Bitget Demo Trading orders when `[trading].bitget_demo_enabled` is true. `review.py` orchestrates LLM post-trade reviews that produce lesson rows.
6. **`agent/`** — LLM layer. `provider.py` builds the multi-timeframe context and normalizes model output to a fixed JSON schema. `providers/codex.py` and `providers/anthropic.py` implement the transport. `loop.py` is a tool-calling agent loop (OpenAI-style function calling internally, converted by each provider); `tools.py` defines the `ToolRegistry` plus two tool factories: `build_market_tools` (read-only data access) and `build_trading_tools` (Hyperliquid mainnet and Bitget demo order entry plus local trade history). `session_store.py` is a SQLite-backed per-instrument chat history at `~/.cache/mytradebot/agent_sessions.sqlite3`.
7. **`api/app.py`** — the only place where async FastAPI meets the sync `TickerController`. It owns the `WebSocket` client set, broadcasts state snapshots (now including `openTrades`), runs a periodic review loop, and exposes all routes under `/api/*` plus `/ws`. This file is large (~1200 lines) because it's the integration seam.

### The one seam that matters

`api/app.py` runs a background task that periodically drains `controller.event_queue` and pushes a JSON snapshot to every connected WebSocket client. Frontend state is a pure projection of these snapshots — there is no client-owned state for quotes/candles. When adding a new data field, add it to the snapshot payload and let the frontend read it; don't introduce a separate REST poll.

### Trade record and external execution pipeline

The agent can submit Hyperliquid mainnet orders via `open_hyperliquid_trade`, or Bitget demo orders via `open_bitget_demo_trade`, during a chat turn only when the matching `[trading]` platform switch is enabled. Disabled platforms do not expose their Agent order-entry tools, so the model should provide trade plans instead of executing orders. Flow:
1. Tool handler submits a signed order to the external test/demo environment and freezes a snapshot (multi-timeframe context + current analysis) into the `snapshots` table.
2. The order result is inserted into `trades`; immediate Hyperliquid fills are inserted into `fills`. Local code no longer simulates fills from 1m candles.
3. Closed trades periodically get reviewed by `trading/review.py` (every 15 min in background, or on-demand via `POST /api/trades/review`). The reviewer calls the configured LLM and writes structured lessons into the `lessons` table.
4. When the agent opens a new trade on the same instrument, the top 5 most recent lessons are injected into the prompt so past mistakes inform new decisions.

Resting orders and later fills require exchange order-state sync; they are not advanced by local candle simulation.

### Agent pipeline

Two modes live side by side:

- **Legacy single-shot**: `provider.py` builds a prompt from the current quote + multi-timeframe OHLCV + recent session turns, calls the LLM once, and parses a strict JSON response (`summary / bias / confidence / key_levels / watch_plan / invalidation / risk_notes`).
- **Tool-calling loop**: `agent/loop.py` runs iterative chat with `ToolRegistry` (market tools, news tools, local trade-history tools, Hyperliquid mainnet entry, and Bitget demo entry). Same output schema. Bounded by `DEFAULT_MAX_ITERATIONS`.

Both persist user/assistant turns to `agent_sessions.sqlite3` via `AgentSessionStore`. The `api_mode` in config selects transport shape — Codex uses Responses API shapes, Anthropic uses Messages API shapes.

### Market-data model

`instrument_key` (e.g. `USDT-FUTURES:BTCUSDT`, `USDC-FUTURES:BTCPERP`, `hyperliquid:BTC`, `hyperliquid:flx:NVDA`) is the canonical identifier used everywhere: queue events, WebSocket payloads, session storage, agent tool arguments. When adding a new data source, define a new `MarketInstrument` variant and extend `router.resolve_instruments` — keep the string format stable because session history and cached candles key on it.

`[analysis]` config (interval, lookback, poll interval) controls the OHLCV fetch loop in `feed.py`. `agent.max_candles` controls how many of those bars get shipped to the LLM. These are independent — the feed can cache more than the agent sees.

### Frontend

`web/src/App.tsx` is the single React root. `api.ts` wraps REST, `types.ts` mirrors backend payload shapes, `chartDrawings.ts` handles Lightweight Charts overlays. The dev server proxies `/api` and `/ws` to the backend (see `vite.config.ts`).

### Tests

`tests/` uses `unittest.TestCase` classes run via pytest. Test files map 1:1 to modules (e.g. `test_feed.py` → `runtime/feed.py`). Feed and controller tests use a fake `worker_factory` to avoid real network. When touching `api/app.py`, run `test_web.py` — it exercises the WebSocket snapshot shape, which the frontend depends on.

## Non-obvious constraints from README

- Bitget symbols that exist in both Spot and Futures require explicit `inst_type` in watchlist.toml.
- The Codex adapter reads Codex CLI auth directly — it does not reuse Hermes auth store and does not allow base URL overrides.
- The app can place Hyperliquid mainnet orders only when `[trading].hyperliquid_enabled = true`, and Bitget Demo Trading orders only when `[trading].bitget_demo_enabled = true`. It does not manage real-money broker lifecycle or compute risk. It's still primarily a research/monitoring tool.
