# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

The backend and frontend are TypeScript. Backend code lives under `tradex/`; the frontend lives under `web/`.

### Running the app

Dev mode can run both processes together:

```bash
npm run dev:all
```

Or run them separately:

# Terminal 1 — Hono backend on :8765
npm run dev:backend

# Terminal 2 — Vite dev server on :5173
npm run dev
```

Production-style local run:

```bash
npm run build
npm run build:backend
npm run start:backend -- --config watchlist.toml --host 127.0.0.1 --port 8765
```

CLI overrides: `--config my.toml`, `--host 127.0.0.1`, `--port 8765`.

### Tests

```bash
# Type-check backend and frontend
npm run typecheck

# Frontend production build
npm run build

# Backend production build
npm run build:backend

# Vitest suite (currently no dedicated tests)
npm test
```

### Required environment

Codex provider reads `$CODEX_HOME/auth.json` (default `~/.codex/auth.json`), or `CODEX_API_KEY` env var.

Bitget Demo Trading uses demo-only API credentials. The backend signs v2 REST requests and always sends `paptrading: 1`:

```bash
export BITGET_DEMO_API_KEY=...
export BITGET_DEMO_API_SECRET=...
export BITGET_DEMO_PASSPHRASE=...
```

## Architecture

This is a local-first market monitoring and LLM research tool. One TypeScript process runs a Hono server that owns all market state; a React/Vite frontend talks to it over REST + a single WebSocket.

### Layering (read in this order if new to the codebase)

The TypeScript backend `tradex/` is organized as strict layers. Upper layers import lower layers, never the reverse:

1. **`domain/`** — pure classes/types. `Candle`, `QuoteState`, `mergeCandles`. No I/O.
2. **`config/`** — parses `watchlist.toml` → `AppConfig`. Also holds agent model normalization (`agent_models.ts`) and `watchlist_store.ts` which round-trips the TOML on add/remove from the UI.
3. **`market_data/`** — per-provider adapters (`bitget.ts`, `hyperliquid.ts`) plus `router.ts` which dispatches `InstrumentConfig` to the right provider and preserves watchlist order. `candle_cache.ts` provides the local OHLCV cache that agent tools read from.
4. **`runtime/`** — `feed.ts` runs background async tasks that stream quotes/candles from providers into controller events. `controller.ts` (`TickerController`) drains those events into an in-memory `QuoteState` map and tracks flash directions.
5. **`trading/`** — local trade records and external live/demo execution. `store.ts` is a SQLite-backed `TradeStore` at `~/.cache/tradex/trades.sqlite3` (tables: trades, fills, snapshots, lessons). `hyperliquid.ts` submits signed Hyperliquid mainnet orders when `[trading].hyperliquid_enabled` is true; `bitget.ts` signs Bitget Demo Trading orders when `[trading].bitget_demo_enabled` is true. `review.ts` orchestrates LLM post-trade reviews that produce lesson rows.
6. **`agent/`** — LLM layer. `providers/codex.ts` and `providers/anthropic.ts` implement the transport. `loop.ts` is a tool-calling agent loop; `tools/` defines `ToolRegistry` and tool packs.
7. **`api/app.ts`** — Hono API and SSE routes. `api/runtime.ts` owns the `TickerController`, local stores, provider services, and state serialization.

### The one seam that matters

`index.ts` serves `/ws` and periodically sends serialized state from `api/runtime.ts`. Frontend state is a pure projection of these snapshots — there is no client-owned state for quotes/candles. When adding a new data field, add it to the snapshot payload and let the frontend read it; don't introduce a separate REST poll.

### Trade record and external execution pipeline

The agent can submit Hyperliquid mainnet orders via `open_hyperliquid_trade`, or Bitget demo orders via `open_bitget_demo_trade`, during a chat turn only when the matching `[trading]` platform switch is enabled. Disabled platforms do not expose their Agent order-entry tools, so the model should provide trade plans instead of executing orders. Flow:
1. Tool handler submits a signed order to the external test/demo environment and freezes a snapshot (multi-timeframe context + current analysis) into the `snapshots` table.
2. The order result is inserted into `trades`; immediate Hyperliquid fills are inserted into `fills`. Local code no longer simulates fills from 1m candles.
3. Closed trades can be reviewed through `trading/review.ts`. The reviewer calls the configured LLM and writes structured lessons into the `lessons` table.
4. When the agent opens a new trade on the same instrument, the top 5 most recent lessons are injected into the prompt so past mistakes inform new decisions.

Resting orders and later fills require exchange order-state sync; they are not advanced by local candle simulation.

### Agent pipeline

Two modes live side by side:

- **Tool-calling loop**: `agent/loop.ts` runs iterative chat with `ToolRegistry` (market tools, news tools, local trade-history tools, Hyperliquid mainnet entry, and Bitget demo entry). Bounded by `DEFAULT_MAX_ITERATIONS`.

Both persist user/assistant turns to `agent_sessions.sqlite3` via `AgentSessionStore`. The `api_mode` in config selects transport shape — Codex uses Responses API shapes, Anthropic uses Messages API shapes.

### Market-data model

`instrument_key` (e.g. `USDT-FUTURES:BTCUSDT`, `USDC-FUTURES:BTCPERP`, `hyperliquid:BTC`, `hyperliquid:flx:NVDA`) is the canonical identifier used everywhere: queue events, WebSocket payloads, session storage, agent tool arguments. When adding a new data source, define a new `MarketInstrument` variant and extend `router.resolve_instruments` — keep the string format stable because session history and cached candles key on it.

`[analysis]` config (interval, lookback, poll interval) controls the OHLCV fetch loop in `feed.ts`. `agent.max_candles` controls how many of those bars get shipped to the LLM. These are independent — the feed can cache more than the agent sees.

### Frontend

`web/src/App.tsx` is the single React root. `api.ts` wraps REST, the live-state WebSocket, and backend payload shapes are mirrored in `types.ts`. The dev server proxies REST `/api` calls to the backend, while the frontend opens `/ws` directly against the local backend in dev to avoid noisy proxy disconnects.

### Tests

There is currently no dedicated test suite after the TypeScript migration. Use `npm run typecheck`, `npm run build`, and targeted smoke checks for touched API/provider paths.

## Non-obvious constraints from README

- Bitget symbols that exist in both Spot and Futures require explicit `inst_type` in watchlist.toml.
- The Codex adapter reads Codex CLI auth directly — it does not reuse Hermes auth store and does not allow base URL overrides.
- The app can place Hyperliquid mainnet orders only when `[trading].hyperliquid_enabled = true`, and Bitget Demo Trading orders only when `[trading].bitget_demo_enabled = true`. It does not manage real-money broker lifecycle or compute risk. It's still primarily a research/monitoring tool.
