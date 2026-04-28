# Feature Specification: Price Action Web UI

**Feature Branch**: `main`
**Created**: 2026-04-28
**Status**: Draft
**Input**: User request: "Remove all PySide logic, including collapsed scrolling ticker logic, and make this project a Web UI product."

## User Scenarios & Testing

### User Story 1 - Use A Browser-Based Trading Workspace (Priority: P1)

As a user monitoring price action, I want a local browser UI with watchlist, K-line chart, and agent explanation panel, so the interface can be richer and smoother than the previous desktop floating widget.

**Independent Test**: Start the local server, load the Web UI, and verify the state endpoint and WebSocket can provide instruments, quotes, candles, and price action state.

**Acceptance Scenarios**:

1. **Given** a configured watchlist, **When** the Web UI loads, **Then** it shows grouped instruments and a selected-symbol chart area.
2. **Given** a symbol has fresh price action analysis, **When** that symbol is selected, **Then** the UI shows the marker, reason, strength, and K-line data.
3. **Given** no built frontend assets exist, **When** the developer runs Vite, **Then** the Web UI can still connect to the Python backend through dev proxy.

---

### User Story 2 - Remove Desktop Floating Behavior (Priority: P1)

As a user moving the product to Web UI, I do not want PySide, collapsed ticker, or scrolling ticker behavior to remain in runtime code, so future UI work happens in one browser-based surface.

**Independent Test**: Search runtime source and dependency files for PySide/Qt/floating ticker references and verify none remain outside historical docs.

**Acceptance Scenarios**:

1. **Given** the project dependencies are installed, **When** Python requirements are read, **Then** no PySide or shiboken dependency is required.
2. **Given** the app starts from `python -m terminal_ticker`, **When** it runs, **Then** it starts a local web server instead of a Qt window.
3. **Given** browser UI is active, **When** the viewport is small, **Then** the layout responds as a web dashboard rather than collapsing into a ticker tape.

---

### User Story 3 - Preserve Market Data And Analysis Behavior (Priority: P2)

As a user relying on the price action agent, I want the provider and analyzer behavior to survive the UI migration, so Bitget and Longbridge analysis still degrade safely on missing or stale candles.

**Independent Test**: Feed deterministic OHLCV candles and stale states through the Python runtime serialization and verify the browser payload marks available and unavailable states correctly.

**Acceptance Scenarios**:

1. **Given** enough fresh candles, **When** the analyzer runs, **Then** the WebSocket payload includes available price action state and candles.
2. **Given** stale or failed candles, **When** the WebSocket payload is serialized, **Then** the analysis is marked unavailable or stale and does not show an active marker.
3. **Given** Longbridge search results, **When** the Web UI queries search, **Then** existing watchlist entries are marked and can be added or removed through local API endpoints.

## Edge Cases

- Latest quote is fresh but candles are missing: show quote normally and keep analysis unavailable.
- Candle fetch succeeds for one symbol and fails for another: update only the successful symbol.
- Longbridge candle access is unavailable or unauthorized: keep raw Longbridge quotes working.
- Frontend WebSocket disconnects: client can reconnect and fetch `/api/state`.
- Built frontend assets are absent in development: Vite dev server proxies `/api` and `/ws`.

## Requirements

- **FR-001**: System MUST derive price action state from structured OHLCV candle data, not screenshot or rendered chart image recognition.
- **FR-002**: System MUST remove PySide/Qt runtime dependencies and Qt widget code.
- **FR-003**: System MUST remove collapsed scrolling ticker UI behavior.
- **FR-004**: System MUST provide a FastAPI local backend with REST snapshot and WebSocket state updates.
- **FR-005**: System MUST provide a browser UI that renders grouped watchlist, selected-symbol K-line chart, and agent explanation panel.
- **FR-006**: System MUST support Bitget public candles and Longbridge candles for configured symbols when provider access is available.
- **FR-007**: System MUST classify trend, range, breakout attempt, pullback, and unavailable states.
- **FR-008**: System MUST treat too few, missing, failed, or stale candles as unavailable and MUST NOT present them as fresh signals.
- **FR-009**: System MUST remain local-first with no cloud service and no new market-data credential requirement.
- **FR-010**: System MUST NOT place trades, send orders, manage positions, or claim financial advice.

## Key Entities

- **Candle**: One OHLCV bar for a symbol and interval.
- **Price Action State**: Derived market context for one symbol, including state, bias, strength, reason, and freshness.
- **Market State Payload**: Serialized browser snapshot containing instruments, quote states, analysis, candles, config, and stream status.
- **Web Runtime**: Local process that owns the controller, drains feed events, and broadcasts WebSocket snapshots.

## Success Criteria

- **SC-001**: Python tests pass with `.venv/bin/python -m unittest discover -s tests`.
- **SC-002**: Frontend production build passes with `npm run build`.
- **SC-003**: Runtime source has no PySide/Qt/floating ticker references.
- **SC-004**: Web UI can render watchlist and K-line chart from serialized state.
- **SC-005**: Existing provider and analyzer tests continue to pass.

## Assumptions

- Browser-based UI is now the product surface; desktop-native packaging is out of scope for this migration.
- Existing TOML watchlist remains the persistence layer.
- Existing provider modules remain the source of truth for quote and candle data.
