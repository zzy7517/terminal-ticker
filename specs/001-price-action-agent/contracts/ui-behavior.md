# UI Behavior Contract: Price Action Web UI

## Application Shell

- The first screen is the working trading surface, not a landing page.
- Layout uses three zones on desktop: watchlist/search, chart workspace, and agent context.
- On narrower screens the zones stack vertically without introducing a collapsed ticker.
- There is no PySide floating window, minimize button, plus/minus expand control, or scrolling ticker tape.

## Watchlist

- Instruments are grouped by `group` from `watchlist.toml`.
- Selecting a row changes the chart and agent panel.
- Rows show label, source, price, percent change, compact marker, and freshness age.
- Stale or unavailable analysis shows a quiet placeholder instead of alert styling.

## Chart Workspace

- The selected symbol renders recent OHLCV candles with Lightweight Charts.
- Empty candle data shows a quiet placeholder.
- Price, change, high, low, volume, and age are visible near the chart.
- Chart interactions are browser-native and must not resize surrounding layout unpredictably.

## Agent Panel

- The agent panel explains the selected symbol's state, reason, feed status, and non-execution boundary.
- The UI must not show buy/sell commands, position sizing, order placement, account status, or broker/trade controls.

## Watchlist Editing

- Longbridge search uses local API endpoints.
- Add/remove actions update both runtime state and the active `watchlist.toml` when a config file is active.
