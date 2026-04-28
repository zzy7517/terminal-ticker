# Research: Price Action Agent

## Decision: Use OHLCV candles instead of chart screenshot recognition

**Rationale**: K-line charts are a rendering of OHLCV data. The current app already owns market data provider boundaries, so deriving analysis from structured candles is more stable than interpreting pixels affected by theme, scale, chart overlays, and resolution.

**Alternatives considered**:

- Screenshot recognition: rejected for live monitoring because visual scaling, theme colors, chart drawings, and missing axis metadata make it fragile.
- LLM-only natural-language chart interpretation: rejected for v1 because it is harder to test deterministically and would add dependency cost.

## Decision: First version supports Bitget candles only

**Rationale**: Bitget is already a public, no-key provider in this app. Keeping v1 to Bitget preserves the local-first and no-new-credential constraints.

**Alternatives considered**:

- Longbridge candles: deferred because current Longbridge integration is quote/search focused and credential-backed.
- Multi-provider candle abstraction first: rejected as too much structure before one provider proves the analysis shape.

## Decision: Use simple deterministic price action rules first

**Rationale**: The feature needs explainable, testable behavior. A small rule set can classify trend, range, breakout attempt, and pullback with deterministic fixtures.

**Alternatives considered**:

- Machine-learning model: rejected for v1 because it needs training data, evaluation, model packaging, and confidence calibration.
- Full strategy engine: rejected because the user asked for a trading agent direction, but the project is still a small local monitor.

## Decision: Display compact state in existing ticker and rows

**Rationale**: The constitution requires the app to stay low-noise. Adding one compact marker and one short row reason gives value without turning the window into a dashboard.

**Alternatives considered**:

- New analysis panel: rejected for v1 because it increases UI footprint.
- Modal detail view: deferred until the signals are useful enough to justify a larger surface.
