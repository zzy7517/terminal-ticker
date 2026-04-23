# Feature Specification: Price Alerts for Floating Ticker

**Feature Branch**: `001-price-alerts`  
**Created**: 2026-04-23  
**Status**: Draft  
**Input**: User description: "Add price alerts for floating ticker"

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Threshold Crossing Alerts (Priority: P1)

As a user watching a small set of symbols in the floating ticker, I want to
define simple price thresholds so that I am visually alerted when a tracked
symbol crosses above or below a price I care about.

**Why this priority**: This is the minimum useful alerting workflow. Without a
reliable threshold crossing alert, the feature does not deliver new monitoring
value.

**Independent Test**: Configure one tracked symbol with an upper or lower price
threshold, feed the app fresh quotes that cross the threshold, and verify that a
single clear alert appears while the ticker keeps running.

**Acceptance Scenarios**:

1. **Given** a tracked symbol has an alert rule for crossing above a target
   price and the current quote is still below that value, **When** a fresh quote
   moves above the target, **Then** the app shows a visible alert for that
   symbol and indicates which threshold was crossed.
2. **Given** a tracked symbol has an alert rule for crossing below a target
   price and the current quote is still above that value, **When** a fresh quote
   moves below the target, **Then** the app shows a visible alert for that
   symbol without interrupting live quote updates.

---

### User Story 2 - Low-Noise Multi-Symbol Monitoring (Priority: P2)

As a user watching several symbols at once, I want alerts to stay compact and
easy to understand so that I can notice the triggered symbol without turning the
floating ticker into a noisy dashboard.

**Why this priority**: The product's main constraint is minimal screen
footprint. Alerting that bloats the UI would conflict with the project's core
value.

**Independent Test**: Configure alerts on multiple tracked symbols, trigger one
rule while the panel is expanded and another while it is collapsed, and verify
that the app surfaces the active alert without forcing a mode change or hiding
live prices.

**Acceptance Scenarios**:

1. **Given** the ticker is expanded and only one symbol triggers, **When** the
   alert appears, **Then** the alert highlights the triggered symbol without
   obscuring unrelated symbols.
2. **Given** the ticker is collapsed and an alert triggers, **When** the user is
   viewing only the ticker strip, **Then** the app exposes a compact alert cue
   without automatically expanding the panel.
3. **Given** a rule has already triggered, **When** the same symbol remains on
   the triggered side of the threshold, **Then** the app does not repeatedly
   fire duplicate alerts for every subsequent quote.

---

### User Story 3 - Safe Behavior on Stale Data (Priority: P3)

As a user relying on the floating ticker for quick decisions, I want alerts to
respect stale or reconnecting feed conditions so that the app never alarms on
misleading data.

**Why this priority**: Alerting is worse than useless if it triggers on stale,
placeholder, or replayed data during reconnect scenarios.

**Independent Test**: Simulate stale quotes, missing prices, and reconnects
around a configured threshold and verify that alerts fire only when a fresh
crossing quote is observed.

**Acceptance Scenarios**:

1. **Given** a quote is missing, placeholder-only, or older than the app's
   freshness limit, **When** it appears to cross a configured threshold,
   **Then** the system does not trigger an alert.
2. **Given** the feed disconnects and later reconnects, **When** the first fresh
   quote arrives on the triggered side of a threshold without an observed live
   crossing, **Then** the system does not backfill an alert from the gap.
3. **Given** a rule has triggered and the price later returns to the non-trigger
   side, **When** the symbol crosses the threshold again on a later fresh quote,
   **Then** the rule becomes eligible to trigger once more.

---

### Edge Cases

- A symbol has multiple alert rules and more than one rule becomes true on the
  same fresh quote.
- The app starts while the current market price is already beyond a configured
  threshold.
- A user enters an invalid or contradictory alert rule for a tracked symbol.
- The ticker is showing placeholder prices for one symbol while other symbols
  continue streaming normally.
- The alert cue is active while the user toggles between expanded and collapsed
  modes.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST allow users to define one or more alert rules for
  symbols that are already present in the tracked watchlist.
- **FR-002**: Each alert rule MUST identify the tracked symbol, the threshold
  value, and whether the rule watches for a crossing above or below that value.
- **FR-003**: The system MUST evaluate alert rules against fresh live quotes and
  trigger an alert only when the price crosses from the non-trigger side to the
  trigger side of the threshold.
- **FR-004**: The system MUST present a visible alert cue that identifies the
  triggered symbol and makes the alert understandable from the floating ticker
  experience.
- **FR-005**: The system MUST avoid repeated duplicate alerts while the price
  remains on the triggered side of the same threshold.
- **FR-006**: The system MUST re-arm a triggered alert rule after the price
  returns to the non-trigger side so that a later fresh recross can trigger a
  new alert.
- **FR-007**: The system MUST preserve live quote visibility when an alert is
  active and MUST NOT automatically expand the ticker from collapsed mode solely
  because an alert fired.
- **FR-008**: The system MUST ignore stale, missing, placeholder, or otherwise
  degraded quote data when evaluating whether to trigger alerts.
- **FR-009**: The system MUST behave deterministically when the app starts with
  the market already beyond a configured threshold; startup state alone must not
  count as an observed crossing event.
- **FR-010**: The system MUST surface invalid alert configuration in a way that
  prevents silent misbehavior and makes the bad rule identifiable to the user.
- **FR-011**: The system MUST continue supporting users who do not configure any
  alerts, with the floating ticker behaving the same as it does today.

### Key Entities *(include if feature involves data)*

- **Alert Rule**: A user-defined condition tied to one tracked symbol, including
  threshold direction, target price, and whether the rule is currently armed or
  already triggered.
- **Alert Event**: A user-visible alert occurrence produced when a fresh quote
  crosses a rule's threshold.
- **Quote Freshness State**: The system's understanding of whether a symbol's
  current price is safe to use for alert evaluation.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: In verification scenarios, a configured threshold crossing is
  surfaced to the user within one normal UI refresh cycle after the first fresh
  crossing quote is received.
- **SC-002**: In verification scenarios, duplicate alerts do not occur while a
  symbol remains continuously on the triggered side of a threshold.
- **SC-003**: In degraded-data scenarios, stale, missing, placeholder, or
  reconnect-gap quotes produce zero false alerts.
- **SC-004**: Users can monitor at least 10 tracked symbols with alert rules
  enabled and still identify both live prices and active alert cues without
  losing the compact floating-window workflow.

## Assumptions

- v1 alert rules are created through the existing local configuration workflow
  rather than a new in-window editor.
- v1 alert delivery is limited to the app's own visual surfaces; operating
  system notifications, sound, and remote delivery are out of scope.
- Alert rules apply only to symbols that are already part of the active
  watchlist.
- The existing quote freshness timeout remains the baseline definition of
  whether data is safe to evaluate unless the implementation plan explicitly
  tightens it.
