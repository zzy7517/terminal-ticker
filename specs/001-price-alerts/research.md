# Research: Price Alerts for Floating Ticker

## Decision 1: Reuse the existing local watchlist workflow for alert setup

- **Decision**: Define alert rules as part of the existing per-symbol watchlist configuration.
- **Rationale**: The project already relies on local TOML input and does not yet
  have an editor surface. Reusing that workflow keeps the feature local-first
  and avoids a second configuration path.
- **Alternatives considered**:
  - In-window alert editor: rejected for v1 because it would add significant UI
    surface area and validation complexity.
  - Separate alert file: rejected because it would duplicate symbol ownership
    and make the small project harder to reason about.

## Decision 2: Use in-window visual alerts only in v1

- **Decision**: Deliver alert feedback through the floating ticker UI itself.
- **Rationale**: This preserves the product's low-noise desktop monitor focus
  and avoids platform-specific notification APIs during the first iteration.
- **Alternatives considered**:
  - System notifications: rejected for v1 because they introduce platform
    branching and a different noise profile.
  - Sound alerts: rejected for v1 because they are intrusive and harder to test.

## Decision 3: Trigger alerts only on observed fresh crossings

- **Decision**: Fire an alert only when a fresh quote moves from the non-trigger
  side of a threshold to the trigger side while the app is actively observing.
- **Rationale**: This prevents false positives at startup, on stale data, and
  after reconnect gaps where the actual crossing was not observed.
- **Alternatives considered**:
  - Trigger immediately if startup price is already beyond the threshold:
    rejected because startup state is not an observed crossing.
  - Trigger on the first post-reconnect quote beyond the threshold: rejected
    because the crossing may have happened during the gap.

## Decision 4: Auto re-arm after price returns across the threshold

- **Decision**: A triggered rule becomes eligible again after the price returns
  to the non-trigger side and later crosses back.
- **Rationale**: This keeps the feature useful during long-running sessions
  without requiring a separate acknowledgment workflow in v1.
- **Alternatives considered**:
  - One-shot rules that require manual reset: rejected for v1 because they add
    state management and extra controls to the compact UI.
  - Fire on every matching quote: rejected because it would spam the user.
