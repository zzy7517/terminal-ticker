# Data Model: Price Alerts for Floating Ticker

## AlertRuleConfig

- **Purpose**: Represents one user-defined threshold rule for a tracked symbol.
- **Fields**:
  - `symbol key`: identifies which tracked symbol owns the rule
  - `direction`: whether the rule watches for a crossing above or below
  - `target price`: the threshold value
  - `label`: optional human-readable name for the rule
- **Validation**:
  - Target price must be a positive numeric value.
  - Direction must be one of the supported crossing modes.
  - Rules may only be defined for symbols already in the watchlist.

## AlertRuntimeState

- **Purpose**: Tracks whether a rule is armed, triggered, or temporarily
  ineligible based on the latest observed fresh quote.
- **Fields**:
  - `rule identifier`: stable reference to the owning rule
  - `armed`: whether the rule can currently fire
  - `last relation`: whether the latest fresh quote was above, below, or unknown
  - `active event`: the currently visible alert event, if any
- **State transitions**:
  - `unknown -> armed`: once the app has a valid fresh baseline quote
  - `armed -> triggered`: when a fresh quote crosses the threshold
  - `triggered -> armed`: when the price returns to the non-trigger side
  - `any state -> unknown`: when quote data becomes unusable for evaluation

## AlertEvent

- **Purpose**: Represents one user-visible alert occurrence.
- **Fields**:
  - `symbol label`
  - `rule label or threshold description`
  - `trigger price`
  - `trigger time`
  - `direction`
- **Lifecycle**:
  - Created when a rule transitions from armed to triggered on a fresh crossing
  - Remains visible long enough for the user to notice the event
  - Clears without affecting live quote rendering after the transient cue expires

## Quote Freshness State

- **Purpose**: Determines whether the latest price is safe to use for alert
  evaluation.
- **Inputs**:
  - current price availability
  - placeholder vs real quote status
  - age relative to the configured stale timeout
  - reconnect gap conditions
- **Rules**:
  - Alert evaluation is blocked whenever freshness is not trusted.
  - Freshness recovers only after a valid live quote arrives.
