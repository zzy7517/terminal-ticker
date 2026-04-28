# Tasks: Price Action Web UI

**Input**: User confirmed migration from PySide floating client to local Web UI.

**Tests**: Tests are required because this removes the UI runtime, changes dependencies, adds API serialization, and adds a frontend build.

## Phase 1: Remove Desktop Runtime

- [x] T001 Delete PySide window code in `terminal_ticker/floating.py`
- [x] T002 Delete Qt widget code in `terminal_ticker/floating_widgets.py`
- [x] T003 Delete Qt-specific tests in `tests/test_floating.py`
- [x] T004 Remove PySide and shiboken dependencies from `requirements.txt`
- [x] T005 Update package docstring away from floating desktop wording

## Phase 2: Add Local Web Backend

- [x] T006 Replace `terminal_ticker/__main__.py` with a web server entry point
- [x] T007 Add FastAPI app creation in `terminal_ticker/web.py`
- [x] T008 Add `/api/state` REST snapshot route
- [x] T009 Add `/ws` WebSocket state stream
- [x] T010 Add Longbridge search/add/remove API routes
- [x] T011 Add market state serialization tests in `tests/test_web.py`

## Phase 3: Add Web UI

- [x] T012 Add Vite/React project files
- [x] T013 Add TypeScript API and payload types
- [x] T014 Add grouped watchlist UI
- [x] T015 Add Lightweight Charts candlestick panel
- [x] T016 Add selected-symbol agent context panel
- [x] T017 Add responsive global CSS

## Phase 4: Documentation

- [x] T018 Rewrite README for Web UI startup and validation
- [x] T019 Update spec, plan, research, quickstart, and UI contract away from floating desktop behavior
- [x] T020 Document that `show_collapsed` is legacy compatibility only

## Phase 5: Verification

- [x] T021 Install updated Python and Node dependencies
- [x] T022 Run `.venv/bin/python -m unittest discover -s tests`
- [x] T023 Run `npm run build`
- [x] T024 Search for remaining PySide/Qt/floating runtime references
- [x] T025 Smoke test local static serving, REST snapshot, and WebSocket state

Note: `watchlist.toml` still contains the pre-existing local `AMD.US` user change. It is not part of this migration.
