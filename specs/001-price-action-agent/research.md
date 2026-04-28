# Research: Price Action Web UI

## Decision: Use OHLCV candles instead of chart screenshot recognition

**Rationale**: K-line charts are a rendering of OHLCV data. The app owns market data provider boundaries, so deriving analysis from structured candles is more stable than interpreting pixels affected by theme, scale, overlays, and resolution.

**Alternatives considered**:

- Screenshot recognition: rejected for live monitoring because visual scaling, theme colors, chart drawings, and missing axis metadata make it fragile.
- LLM-only natural-language chart interpretation: rejected because it is harder to test deterministically and would add dependency cost.

## Decision: Replace PySide with local Web UI

**Rationale**: Price action work benefits from mature chart interactions, flexible layout, and faster UI iteration. React plus Lightweight Charts provides candlestick rendering, responsive layout, and future panel work with less custom drawing than PySide.

**Alternatives considered**:

- Continue PySide custom painting: rejected because chart interaction and layout work would keep growing.
- Electron/Tauri immediately: deferred because the local browser product shape should prove itself before desktop packaging.
- Static HTML only: rejected because the app needs stateful watchlist, chart, and agent panels.

## Decision: Keep Python provider and analyzer layers

**Rationale**: Existing Bitget, Longbridge, and price action modules are tested and provider-aware. Reusing them lowers migration risk and keeps market credentials in the Python process.

**Alternatives considered**:

- Move provider calls to the browser: rejected because credentials and provider APIs should not be exposed client-side.
- Add a cloud backend: rejected because the app is local-first.

## Decision: FastAPI REST plus WebSocket

**Rationale**: REST gives initial state and command endpoints; WebSocket gives a simple live state stream for quote and analysis updates.

**Alternatives considered**:

- Server-sent events: possible for one-way state, but less flexible for future client messages.
- Polling only: simpler but less responsive and wasteful for live quote changes.
