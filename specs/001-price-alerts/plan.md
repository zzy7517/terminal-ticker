# Implementation Plan: Price Alerts for Floating Ticker

**Branch**: `001-price-alerts` | **Date**: 2026-04-23 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/001-price-alerts/spec.md`

## Summary

Implement local price alerts by extending the existing watchlist configuration
with per-symbol threshold rules, adding runtime alert evaluation state on top of
current quote freshness handling, and surfacing compact alert cues in the
floating window without disrupting the low-noise ticker workflow.

## Technical Context

**Language/Version**: Python 3.13  
**Primary Dependencies**: PySide6, websockets, Python standard library (`tomllib`, `dataclasses`)  
**Storage**: Local TOML configuration plus in-memory runtime alert state  
**Testing**: `python3 -m unittest discover -s tests`  
**Target Platform**: macOS and Linux desktop  
**Project Type**: Single-package desktop application  
**Performance Goals**: Alert evaluation completes inside the existing quote/UI update cadence without introducing visible lag  
**Constraints**: No backend service, no API keys, no forced panel expansion, no alerts on stale or reconnect-gap data  
**Scale/Scope**: At least 10 tracked symbols with alert rules active in the same session

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

- Pass: The feature stays inside the local desktop app and does not add a backend or remote dependency.
- Pass: Alerting is designed as a compact visual enhancement rather than a new control-heavy dashboard.
- Pass: The plan treats stale, missing, and reconnect-gap quotes as ineligible for alert firing.
- Pass: Changes stay additive within `terminal_ticker/` and `tests/`; no runtime or framework swap is proposed.
- Pass: Automated coverage is included for config parsing, runtime alert state, and floating-window behavior.

## Project Structure

### Documentation (this feature)

```text
specs/001-price-alerts/
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── checklists/
│   └── requirements.md
└── tasks.md
```

### Source Code (repository root)

```text
terminal_ticker/
├── __main__.py
├── bitget.py
├── config.py
├── floating.py
└── models.py

tests/
├── test_bitget.py
├── test_config.py
├── test_floating.py
└── test_models.py
```

**Structure Decision**: Extend the current package in place. Alert rule parsing
lives with config parsing, alert runtime state lives with quote state, and
user-visible alert cues stay in the floating UI module. No new service boundary
or standalone subsystem is needed for v1.

## Complexity Tracking

No constitution violations are expected for this feature.
