# Quickstart: Price Alerts for Floating Ticker

## 1. Add alert rules to the watchlist configuration

After implementation, configure one or more alert rules on tracked symbols.
Example intended shape:

```toml
symbols = [
  { symbol = "BTCUSDT", inst_type = "USDT-FUTURES", label = "BTC", alerts = [
    { when = "above", price = 80000, name = "Breakout" },
    { when = "below", price = 76000, name = "Support Lost" },
  ] },
  { symbol = "ETHUSDT", inst_type = "USDT-FUTURES", label = "ETH", alerts = [
    { when = "above", price = 4200, name = "ETH Strength" },
  ] },
]
```

## 2. Launch the ticker

```bash
python3 -m terminal_ticker --config watchlist.toml
```

## 3. Verify threshold crossing behavior

1. Start with a symbol whose live price is still on the non-trigger side of a configured threshold.
2. Wait for a fresh quote to cross the threshold.
3. Confirm that a visible alert cue appears for the triggered symbol.
4. Confirm that live prices continue updating and the window does not auto-expand if it is collapsed.

## 4. Verify duplicate suppression and re-arm behavior

1. Keep the symbol on the triggered side and confirm duplicate quotes do not create repeated alerts.
2. Wait for the price to move back across the threshold.
3. Confirm that a later recross can trigger a new alert.

## 5. Verify stale-data protections

1. Simulate or force a disconnect/reconnect gap.
2. Confirm that stale or placeholder prices do not trigger alerts.
3. Confirm that the first fresh quote after reconnect establishes a safe baseline instead of backfilling a missed crossing alert.
