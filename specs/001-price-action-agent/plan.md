# Implementation Plan: Price Action Agent

**Branch**: `001-price-action-agent` | **Date**: 2026-04-28 | **Spec**: [spec.md](spec.md)  
**Input**: Feature specification from `/specs/001-price-action-agent/spec.md`

## Summary

Build a local-first price action layer for Bitget symbols by fetching public OHLCV candles, deriving deterministic trend/range/breakout/pullback states, and presenting compact non-execution context in the existing floating ticker UI. The agent will not read chart screenshots or place trades.

## Technical Context

**Language/Version**: Python 3.x in the existing virtual environment  
**Primary Dependencies**: PySide6, websockets, longbridge, Python standard library urllib/json/dataclasses  
**Storage**: Local runtime memory and existing TOML config only  
**Testing**: `unittest` via `.venv/bin/python -m unittest discover -s tests`  
**Target Platform**: macOS/Linux desktop  
**Project Type**: local desktop app  
**Performance Goals**: Candle polling must not block UI; analysis should run in the existing feed worker path and update rows on timer-driven drain.  
**Constraints**: No backend service, no new credential requirement, no automatic trading, no screenshot chart recognition.  
**Scale/Scope**: Existing watchlist-sized local monitoring, first version for Bitget instruments only.

## Constitution Check

- Preserve local-first desktop scope: PASS. Uses Bitget public REST and local runtime state.
- Preserve minimal-footprint UI: PASS. Adds compact markers/reason inside existing ticker/rows.
- Protect feed integrity: PASS. Missing, too few, failed, or stale candles map to unavailable analysis.
- Prefer additive evolution inside `terminal_ticker/` and `tests/`: PASS. Adds focused modules and extends feed/controller/model/UI.
- Define automated verification: PASS. Adds analyzer, Bitget candle normalization, controller, ticker, and row tests.

## Project Structure

### Documentation (this feature)

```text
specs/001-price-action-agent/
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   └── ui-behavior.md
└── tasks.md
```

### Source Code (repository root)

```text
terminal_ticker/
├── bitget.py              # Add public candle fetch and normalization
├── config.py              # Add analysis settings
├── controller.py          # Apply analysis events to quote state
├── feed.py                # Poll candles independently from quotes
├── floating_widgets.py    # Render compact markers in ticker and rows
├── models.py              # Store derived price action state
└── price_action.py        # New deterministic analyzer

tests/
├── test_bitget.py
├── test_config.py
├── test_controller.py
├── test_floating.py
├── test_models.py
└── test_price_action.py
```

**Structure Decision**: Add one new `price_action.py` module because candle entities and analysis rules are a separate domain from raw quote formatting. Keep provider fetch in `bitget.py` and UI rendering in existing widget files.

## Complexity Tracking

No constitution violations.

## Phase 0: Research

Completed in [research.md](research.md).

## Phase 1: Design

Completed in [data-model.md](data-model.md), [contracts/ui-behavior.md](contracts/ui-behavior.md), and [quickstart.md](quickstart.md).

## Phase 2: Implementation Approach

1. Add tests first for candle parsing and deterministic analyzer states.
2. Add `PriceActionState` storage to quote state.
3. Add Bitget candle REST fetch for configured Bitget instruments.
4. Extend feed events with `price_action` updates without blocking quote flow.
5. Render compact markers in collapsed ticker and expanded rows.
6. Verify full unit suite with the project virtual environment.
