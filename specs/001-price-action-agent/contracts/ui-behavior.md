# UI Behavior Contract: Price Action Agent

## Collapsed Ticker

For each collapsed-visible symbol:

- If price exists and fresh analysis exists, show `LABEL PRICE MARKER`.
- If price exists but analysis is unavailable, show `LABEL PRICE`.
- If price is missing, preserve existing placeholder behavior.

Examples:

- `BTC 78001.50 BO+`
- `ETH 3560.20 RG`
- `XAU -`

## Expanded Row

Each quote row remains fixed height.

- Left side: symbol label.
- Right side: price label.
- Secondary line or compact label area: state marker plus short reason.
- Stale quote styling remains controlled by quote freshness.
- Stale or unavailable analysis must not use alert styling.

## Expanded Detail Area

When the window is expanded and tall enough:

- Clicking a quote row selects that instrument.
- The detail area shows the selected label, compact state marker, concise reason, and recent K-line preview.
- If candles are missing or stale, the chart area shows a quiet placeholder instead of inferring from quotes.
- The detail area is hidden in collapsed mode and in very short resized windows.

## Non-Execution Boundary

The UI must not show buy/sell commands, position sizing, order placement, account status, or broker/trade controls in v1.
