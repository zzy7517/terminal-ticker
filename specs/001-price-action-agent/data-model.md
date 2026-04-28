# Data Model: Price Action Agent

## Candle

Represents one OHLCV bar.

- `symbol_key`: stable provider symbol key, such as `USDT-FUTURES:BTCUSDT` or `longbridge:AAPL.US`
- `open_time_ms`: candle open timestamp in milliseconds
- `open`: opening price
- `high`: highest traded price during the candle
- `low`: lowest traded price during the candle
- `close`: closing price
- `volume`: traded base volume

Validation:

- `high` must be greater than or equal to `open`, `close`, and `low`.
- `low` must be less than or equal to `open`, `close`, and `high`.
- Numeric fields must be parseable floats.

## PriceActionState

Represents derived context for one symbol.

- `label`: one of `trend`, `range`, `breakout`, `pullback`, `unavailable`
- `bias`: one of `bullish`, `bearish`, `neutral`
- `marker`: compact UI marker, such as `TR+`, `RG`, `BO+`, `PB-`
- `reason`: short user-facing explanation
- `strength`: integer score from 0 to 100
- `updated_at`: time when analysis was produced
- `error`: optional unavailable reason

Validation:

- `unavailable` must use `neutral` bias and strength `0`.
- Available states must include a non-empty marker and reason.

## AnalysisSettings

Controls local analysis behavior.

- `enabled`: whether to fetch and analyze supported provider candles
- `interval`: candle interval, default `5m`
- `lookback`: number of candles to request and analyze, default `40`
- `poll_interval_seconds`: candle refresh interval, default `30`
- `stale_after_seconds`: maximum age for derived analysis and latest candle, default `420`

Validation:

- `lookback` must be at least `10`.
- `poll_interval_seconds` and `stale_after_seconds` must be positive.

## MarketStatePayload

Represents the complete browser state snapshot sent by REST and WebSocket.

- `updatedAt`: server serialization timestamp
- `streamStatus`: current provider feed status
- `config`: display and analysis settings relevant to the UI
- `instruments`: resolved watchlist instruments with key, symbol, label, source, and group
- `groups`: mapping from group name to instrument keys
- `quotes`: mapping from instrument key to quote state, price action state, and recent candles

Validation:

- Every key in `groups` must reference an existing instrument key.
- `quotes` may omit live values before provider data arrives, but must keep placeholder rows.
- Stale price action must be marked unavailable or stale before it reaches the UI as an active marker.

## WebRuntime

Owns the running local web process.

- `config`: active app config
- `instruments`: resolved provider instruments
- `controller`: quote and feed event controller
- `clients`: connected WebSocket clients

Validation:

- Runtime must stop provider feeds when the app shuts down.
- Runtime reloads must restart the controller after watchlist edits.
- WebSocket disconnects must not stop provider feeds.
