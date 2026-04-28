# Tasks: Price Action Agent

**Input**: Design documents from `/specs/001-price-action-agent/`  
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/ui-behavior.md, quickstart.md

**Tests**: Tests are expected because this changes config parsing, provider normalization, derived state, feed events, and UI rendering.

**Organization**: Tasks are grouped by user story to enable independent implementation and testing of each story.

## Phase 1: Setup (Shared Infrastructure)

- [x] T001 Update `.specify/feature.json` to point at `specs/001-price-action-agent`
- [x] T002 Update `AGENTS.md` SPECKIT block to point at `specs/001-price-action-agent/plan.md`

---

## Phase 2: Foundational (Blocking Prerequisites)

- [x] T003 [P] Add deterministic analyzer tests in `tests/test_price_action.py`
- [x] T004 [P] Add analysis config parsing tests in `tests/test_config.py`
- [x] T005 [P] Add Bitget candle normalization tests in `tests/test_bitget.py`
- [x] T006 Implement candle and analysis types plus deterministic classification in `terminal_ticker/price_action.py`
- [x] T007 Add analysis config defaults and parsing in `terminal_ticker/config.py`
- [x] T008 Add Bitget candle REST fetch helpers in `terminal_ticker/bitget.py`

**Checkpoint**: Analyzer and provider candle data are independently testable.

---

## Phase 3: User Story 1 - See Price Action State (Priority: P1) MVP

**Goal**: Supported symbols receive derived trend/range/breakout/pullback state from OHLCV candles.

**Independent Test**: Feed analysis events into the controller and verify quote state stores the expected marker, bias, and reason.

### Tests for User Story 1

- [x] T009 [P] [US1] Add quote-state analysis update tests in `tests/test_models.py`
- [x] T010 [P] [US1] Add controller analysis event tests in `tests/test_controller.py`

### Implementation for User Story 1

- [x] T011 [US1] Store price action state on `QuoteState` in `terminal_ticker/models.py`
- [x] T012 [US1] Apply `price_action` feed events in `terminal_ticker/controller.py`
- [x] T013 [US1] Poll and analyze Bitget candles in `terminal_ticker/feed.py`
- [x] T025 [US1] Poll and analyze Longbridge candles in `terminal_ticker/feed.py` and `terminal_ticker/longbridge_provider.py`

**Checkpoint**: User Story 1 works without UI changes by inspecting quote state.

---

## Phase 4: User Story 2 - Keep Alerts Low Noise (Priority: P2)

**Goal**: Collapsed ticker and rows display compact analysis while expanded mode offers richer selected-symbol context.

**Independent Test**: Build ticker items and row widgets from quote states with and without analysis and verify layout-compatible labels.

### Tests for User Story 2

- [x] T014 [P] [US2] Add collapsed ticker marker tests in `tests/test_floating.py`
- [x] T015 [P] [US2] Add expanded row marker tests in `tests/test_floating.py`

### Implementation for User Story 2

- [x] T016 [US2] Append compact analysis markers in `terminal_ticker/floating_widgets.py`
- [x] T017 [US2] Render expanded row analysis labels in `terminal_ticker/floating_widgets.py`
- [x] T026 [US2] Add selected-symbol K-line detail panel in `terminal_ticker/floating.py` and `terminal_ticker/floating_widgets.py`

**Checkpoint**: User Story 2 is compact in collapsed mode and richer in normal expanded mode.

---

## Phase 5: User Story 3 - Degrade Safely On Missing Or Stale Candles (Priority: P3)

**Goal**: Candle failures and stale analysis never appear as fresh signals.

**Independent Test**: Feed failures, too few candles, and stale analysis into model/UI tests and verify unavailable or omitted markers.

### Tests for User Story 3

- [x] T018 [P] [US3] Add unavailable analysis tests in `tests/test_price_action.py`
- [x] T019 [P] [US3] Add stale analysis rendering tests in `tests/test_floating.py`

### Implementation for User Story 3

- [x] T020 [US3] Ensure unavailable/stale states are omitted from collapsed ticker markers in `terminal_ticker/floating_widgets.py`
- [x] T021 [US3] Ensure candle fetch errors do not stop quote feeds in `terminal_ticker/feed.py`

**Checkpoint**: Analysis degrades safely while quotes continue.

---

## Phase 6: Polish & Cross-Cutting Concerns

- [x] T022 [P] Document analysis config and non-execution boundary in `README.md`
- [x] T023 Update feature docs for Longbridge analysis and expanded detail behavior
- [x] T024 Run `.venv/bin/python -m unittest discover -s tests`
- [x] T027 Review `git diff` to ensure `watchlist.toml` user changes were not touched

Note: `watchlist.toml` still contains the pre-existing local `AMD.US` user change. It is not part of this feature implementation.

## Dependencies & Execution Order

- Phase 1 must complete before implementation.
- Phase 2 blocks all user stories.
- User Story 1 is the MVP and must complete before UI display work.
- User Story 2 depends on User Story 1 state.
- User Story 3 can be implemented alongside User Story 2 after foundational analyzer behavior exists.
- Polish runs last.

## Implementation Strategy

MVP first: complete setup, foundation, and User Story 1; then add compact UI rendering; then harden stale/unavailable behavior.
