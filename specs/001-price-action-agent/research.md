# Research: Price Action Agent

## Decision: Use OHLCV candles instead of chart screenshot recognition

**Rationale**: K-line charts are a rendering of OHLCV data. The current app already owns market data provider boundaries, so deriving analysis from structured candles is more stable than interpreting pixels affected by theme, scale, chart overlays, and resolution.

**Alternatives considered**:

- Screenshot recognition: rejected for live monitoring because visual scaling, theme colors, chart drawings, and missing axis metadata make it fragile.
- LLM-only natural-language chart interpretation: rejected for v1 because it is harder to test deterministically and would add dependency cost.

## Decision: Use provider-owned candles for Bitget and Longbridge

**Rationale**: Bitget is already a public, no-key provider in this app, and Longbridge is already the configured credential-backed provider for US equities and ETFs. Using each provider's structured candle endpoint keeps the analysis deterministic while avoiding screenshot recognition.

**Alternatives considered**:

- Screenshot recognition for Longbridge charts: rejected for the same reasons as chart screenshot recognition generally.
- A separate market-data backend: rejected because the app is local-first and watchlist-sized.

## Decision: Use simple deterministic price action rules first

**Rationale**: The feature needs explainable, testable behavior. A small rule set can classify trend, range, breakout attempt, and pullback with deterministic fixtures.

**Alternatives considered**:

- Machine-learning model: rejected for v1 because it needs training data, evaluation, model packaging, and confidence calibration.
- Full strategy engine: rejected because the user asked for a trading agent direction, but the project is still a small local monitor.

## Decision: Display compact state in ticker/rows and richer details only in expanded mode

**Rationale**: Collapsed mode must remain low-noise, but the user now has a resizable expanded panel and expects the normal state to carry more analysis. A selected-symbol K-line preview gives price action context without changing collapsed behavior.

**Alternatives considered**:

- Full dashboard layout: rejected because it would make the floating utility too heavy.
- Modal detail view: rejected because selecting a row should update context in place.
