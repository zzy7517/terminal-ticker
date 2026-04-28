# Feature Specification: Price Action Agent

**Feature Branch**: `001-price-action-agent`  
**Created**: 2026-04-28  
**Status**: Draft  
**Input**: User description: "Make this project into a price action trading agent; the hard problem is how the agent should identify candlestick charts."

> Project guardrails: keep the feature local-first, preserve the compact
> floating-window experience, and define safe behavior for stale or reconnecting
> market data.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - See Price Action State (Priority: P1)

As a user watching the floating ticker, I want each supported Bitget or Longbridge symbol to show a compact price action state derived from recent candles, so I can see whether the market is trending, ranging, breaking out, or pulling back without reading a full chart.

**Why this priority**: This is the smallest useful agent behavior. It answers the original K-line recognition question by using structured candle data instead of image recognition.

**Independent Test**: Feed deterministic OHLCV candles for one symbol and verify the app derives the expected state and explanation without requiring live network data.

**Acceptance Scenarios**:

1. **Given** a configured supported symbol with enough recent candles, **When** the candle feed is analyzed, **Then** the quote state includes a price action label, bias, and one-sentence reason.
2. **Given** a strong close above the recent candle range, **When** the analyzer runs, **Then** the symbol is marked as a breakout attempt with bullish bias.
3. **Given** overlapping recent candles with small progress, **When** the analyzer runs, **Then** the symbol is marked as range behavior with neutral bias.

---

### User Story 2 - Keep Alerts Low Noise (Priority: P2)

As a user keeping the window in the corner of the screen, I want only meaningful non-execution alerts to appear in the collapsed ticker and rows, so the agent helps me monitor context without becoming a trading terminal.

**Why this priority**: The current app is intentionally small and ambient. Agent output must fit that design instead of adding a noisy panel.

**Independent Test**: Feed candles that move between neutral, pullback, and breakout states and verify the collapsed ticker text changes only to compact labels while expanded rows retain readable price layout.

**Acceptance Scenarios**:

1. **Given** the window is collapsed, **When** a symbol has a fresh price action state, **Then** the ticker item includes price plus a short state marker.
2. **Given** the window is expanded, **When** a symbol has a fresh price action state, **Then** the row shows the state and reason without increasing row height.
3. **Given** the state is neutral or unavailable, **When** the ticker renders, **Then** it avoids alarm-style wording.

---

### User Story 3 - Degrade Safely On Missing Or Stale Candles (Priority: P3)

As a user relying on the agent for context, I want stale, missing, or incomplete candle data to be clearly treated as unavailable, so the app never presents an old signal as current.

**Why this priority**: Derived trading context is more dangerous than raw quotes if freshness is ambiguous.

**Independent Test**: Feed missing candles, too few candles, and stale candle events and verify the app shows unavailable analysis while raw quote behavior continues.

**Acceptance Scenarios**:

1. **Given** fewer than the minimum required candles are available, **When** the analyzer runs, **Then** the symbol has no actionable price action state.
2. **Given** candle fetch fails while quote updates still work, **When** the UI refreshes, **Then** raw quotes continue and the agent state remains unavailable.
3. **Given** candles are older than the configured freshness threshold, **When** the UI renders, **Then** the state is shown as stale or omitted rather than fresh.

### Edge Cases

- Latest quote is fresh but candles are missing: show quote normally and omit the agent state.
- Candle fetch succeeds for one symbol and fails for another: update only the successful symbol.
- Reconnect returns snapshots before candle analysis: do not infer a price action state from quote snapshots alone.
- Longbridge candle access is unavailable or unauthorized: keep raw Longbridge quotes working and omit stale or missing analysis.
- Very small collapsed window: prefer compact markers such as `BO`, `PB`, `TR`, `RG` over full explanations.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: System MUST derive price action state from structured OHLCV candle data, not from screenshot or rendered chart image recognition.
- **FR-002**: System MUST support Bitget public candles and Longbridge candles for configured Longbridge symbols when credentials and market data permission are available.
- **FR-003**: System MUST classify at least these states: trend, range, breakout attempt, pullback, and unavailable.
- **FR-004**: System MUST attach a directional bias to available states: bullish, bearish, or neutral.
- **FR-005**: System MUST provide a concise human-readable reason for each available state.
- **FR-006**: System MUST show compact state markers in the collapsed ticker when fresh analysis is available.
- **FR-007**: System MUST show state and reason in expanded quote rows and provide a selected-symbol detail area with a compact K-line preview in normal expanded mode.
- **FR-008**: System MUST treat too few, missing, failed, or stale candles as unavailable and MUST NOT present them as fresh signals.
- **FR-009**: System MUST remain local-first with no backend service and no new credential requirement for core Bitget behavior.
- **FR-010**: System MUST NOT place trades, send orders, manage positions, or claim financial advice in v1.

### Key Entities *(include if feature involves data)*

- **Candle**: One OHLCV bar for a symbol and interval, including open time, open, high, low, close, volume, and source freshness time.
- **Price Action State**: Derived market context for one symbol, including state, bias, strength, reason, and freshness time.
- **Analysis Settings**: Local configuration that controls interval, lookback, and freshness threshold.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Given deterministic candle fixtures, the app classifies trend, range, breakout, pullback, and unavailable states with passing automated tests.
- **SC-002**: Collapsed ticker items remain one line per symbol and include no more than one compact agent marker per symbol.
- **SC-003**: Expanded quote rows remain scannable while showing price action state, and the selected-symbol detail area can show recent K-lines without affecting collapsed mode.
- **SC-004**: If candle fetching fails for all symbols, existing quote display and reconnect behavior continue to work.
- **SC-005**: The relevant automated test suite passes using `.venv/bin/python -m unittest discover -s tests`.

## Assumptions

- The first version analyzes Bitget public candle data and Longbridge candle data for configured instruments when provider access is available.
- The agent is a monitoring and explanation layer, not an automated trading system.
- OHLCV recognition is the product path; screenshot/chart-image interpretation is deferred to a separate future review tool.
- Existing quote freshness and reconnect behavior remain the baseline for raw quote display.
