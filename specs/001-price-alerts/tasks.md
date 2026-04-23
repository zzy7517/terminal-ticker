# Tasks: Price Alerts for Floating Ticker

**Input**: Design documents from `/specs/001-price-alerts/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, quickstart.md

**Tests**: Tests are required for config parsing, alert state transitions, and
floating-window behavior introduced by this feature.

**Organization**: Tasks are grouped by user story so each story can be
implemented and verified independently.

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Prepare shared documentation and implementation boundaries

- [ ] T001 Confirm the alert configuration shape and examples in `specs/001-price-alerts/quickstart.md`
- [ ] T002 Record the implementation entry points in `specs/001-price-alerts/plan.md`

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Core alert configuration and runtime state needed by every story

**⚠️ CRITICAL**: No user story work should begin until this phase is complete

- [ ] T003 [P] Add alert rule config models and validation in `terminal_ticker/config.py`
- [ ] T004 [P] Add valid and invalid alert config coverage in `tests/test_config.py`
- [ ] T005 Extend runtime alert evaluation state and re-arm logic in `terminal_ticker/models.py`
- [ ] T006 [P] Add alert state transition coverage in `tests/test_models.py`
- [ ] T007 Thread configured alert rules into the floating window runtime in `terminal_ticker/floating.py`

**Checkpoint**: Alert rules can be loaded, tracked, and evaluated in memory

---

## Phase 3: User Story 1 - Threshold Crossing Alerts (Priority: P1) 🎯 MVP

**Goal**: Surface one clear alert when a tracked symbol crosses a configured threshold

**Independent Test**: Configure one symbol with an alert rule, feed fresh quotes
that cross the threshold, and verify that exactly one visible alert cue appears.

### Tests for User Story 1

- [ ] T008 [P] [US1] Add threshold crossing UI coverage in `tests/test_floating.py`
- [ ] T009 [P] [US1] Add baseline-crossing evaluation coverage in `tests/test_models.py`

### Implementation for User Story 1

- [ ] T010 [US1] Implement alert event creation on fresh crossings in `terminal_ticker/models.py`
- [ ] T011 [US1] Render expanded-mode alert cues and triggered symbol context in `terminal_ticker/floating.py`
- [ ] T012 [US1] Ensure startup state seeds the baseline without firing a false alert in `terminal_ticker/floating.py`

**Checkpoint**: A user can receive one reliable in-window alert for a fresh threshold crossing

---

## Phase 4: User Story 2 - Low-Noise Multi-Symbol Monitoring (Priority: P2)

**Goal**: Keep alerts compact and understandable across expanded and collapsed modes

**Independent Test**: Configure alerts for multiple symbols, trigger one while
expanded and another while collapsed, and verify cues stay compact and non-duplicative.

### Tests for User Story 2

- [ ] T013 [P] [US2] Add collapsed-mode alert cue coverage in `tests/test_floating.py`
- [ ] T014 [P] [US2] Add duplicate-suppression coverage in `tests/test_models.py`

### Implementation for User Story 2

- [ ] T015 [US2] Implement collapsed ticker alert indication without auto-expanding in `terminal_ticker/floating.py`
- [ ] T016 [US2] Prevent duplicate alert firing while a rule stays triggered in `terminal_ticker/models.py`
- [ ] T017 [US2] Clear or decay transient alert cues without hiding ongoing live prices in `terminal_ticker/floating.py`

**Checkpoint**: Alerts remain readable and low-noise across multiple symbols and window modes

---

## Phase 5: User Story 3 - Safe Behavior on Stale Data (Priority: P3)

**Goal**: Prevent misleading alerts during stale, missing, or reconnect-gap conditions

**Independent Test**: Simulate stale quotes and reconnects around a threshold
and verify that only a later fresh observed crossing can fire an alert.

### Tests for User Story 3

- [ ] T018 [P] [US3] Add stale and placeholder quote coverage in `tests/test_models.py`
- [ ] T019 [P] [US3] Add reconnect-gap alert protection coverage in `tests/test_floating.py`

### Implementation for User Story 3

- [ ] T020 [US3] Block alert evaluation for stale or unusable quotes in `terminal_ticker/models.py`
- [ ] T021 [US3] Reset alert baselines safely after reconnects in `terminal_ticker/floating.py`
- [ ] T022 [US3] Ensure alert cues stay consistent when quotes become stale mid-session in `terminal_ticker/floating.py`

**Checkpoint**: Alerting behaves safely under degraded-data conditions

---

## Phase 6: Polish & Cross-Cutting Concerns

**Purpose**: Finish user-facing docs and run full verification

- [ ] T023 [P] Update alert setup documentation in `README.md`
- [ ] T024 [P] Add alert examples to `watchlist.toml`
- [ ] T025 Run `python3 -m unittest discover -s tests`
- [ ] T026 Validate the manual flow in `specs/001-price-alerts/quickstart.md`

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: Can start immediately
- **Foundational (Phase 2)**: Blocks all user story work
- **User Story 1 (Phase 3)**: Starts after Phase 2
- **User Story 2 (Phase 4)**: Starts after Phase 2 and should build on US1 alert primitives
- **User Story 3 (Phase 5)**: Starts after Phase 2 and may refine US1 alert evaluation behavior
- **Polish (Phase 6)**: Starts after desired user stories are complete

### User Story Dependencies

- **US1**: Depends only on foundational alert parsing and runtime state
- **US2**: Depends on US1 alert creation behavior
- **US3**: Depends on foundational runtime state and may tighten US1 evaluation rules

### Parallel Opportunities

- T003 and T004 can run in parallel
- T005 and T006 can run in parallel after the config shape is settled
- T008 and T009 can run in parallel
- T013 and T014 can run in parallel
- T018 and T019 can run in parallel
- T023 and T024 can run in parallel

## Implementation Strategy

### MVP First

1. Finish Phase 2
2. Deliver User Story 1
3. Run the focused tests for config, model, and floating behavior
4. Validate the manual threshold-crossing flow

### Incremental Delivery

1. Add reliable crossing alerts
2. Add compact multi-symbol and collapsed-mode cues
3. Tighten stale-data and reconnect protections
4. Update docs and run full regression tests

## Notes

- Keep default UI noise low at every step.
- Do not treat startup price or reconnect-gap price as an observed crossing.
- Favor additive changes in `terminal_ticker/` over new subsystems.
