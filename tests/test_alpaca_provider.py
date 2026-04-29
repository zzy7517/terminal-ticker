"""Test Alpaca provider normalization and search."""
import unittest
from unittest.mock import patch

from terminal_ticker.alpaca_provider import (
    AlpacaInstrument,
    clear_asset_cache,
    fetch_candles,
    fetch_snapshot_payloads,
    resolve_instruments,
    search_assets,
)
from terminal_ticker.config import InstrumentConfig


class AlpacaProviderTests(unittest.TestCase):
    """Group tests for AlpacaProviderTests."""

    def tearDown(self) -> None:
        """Clean up shared cache fixtures."""
        clear_asset_cache()

    def test_resolve_instruments_strips_legacy_us_suffix(self) -> None:
        """Verify Alpaca config accepts old .US symbols."""
        instruments = resolve_instruments(
            (
                InstrumentConfig(
                    symbol="AAPL.US",
                    source="alpaca",
                    label="Apple",
                    show_collapsed=False,
                    group="watchlist",
                ),
            )
        )

        self.assertEqual(instruments[0].key, "alpaca:AAPL")
        self.assertEqual(instruments[0].symbol, "AAPL")
        self.assertFalse(instruments[0].show_collapsed)
        self.assertEqual(instruments[0].group, "watchlist")

    def test_fetch_snapshot_payloads_batches_symbols_and_normalizes_quotes(self) -> None:
        """Verify Alpaca snapshots normalize quote payloads."""
        instruments = (
            AlpacaInstrument("AAPL", "AAPL"),
            AlpacaInstrument("SPY", "SPY"),
        )
        calls = []

        def fake_fetch(_base_url, path, params):
            calls.append((path, params))
            return {
                "snapshots": {
                    "AAPL": {
                        "latestTrade": {"p": 201.5, "t": "2026-04-28T19:55:00Z"},
                        "dailyBar": {"h": 202.0, "l": 199.8, "v": 123456},
                        "prevDailyBar": {"c": 200.25},
                    },
                    "SPY": {
                        "minuteBar": {"c": 500.25, "t": "2026-04-28T19:55:00Z"},
                        "prevDailyBar": {"c": 499.25},
                    },
                }
            }

        with patch("terminal_ticker.alpaca_provider._fetch_json", side_effect=fake_fetch):
            payloads = fetch_snapshot_payloads(instruments)

        self.assertEqual(calls[0][0], "/v2/stocks/snapshots")
        self.assertEqual(calls[0][1]["symbols"], "AAPL,SPY")
        self.assertEqual(payloads["alpaca:AAPL"]["price"], 201.5)
        self.assertAlmostEqual(payloads["alpaca:AAPL"]["change"], 1.25)
        self.assertAlmostEqual(payloads["alpaca:AAPL"]["change_percent"], 0.6242, places=4)
        self.assertEqual(payloads["alpaca:AAPL"]["exchange"], "Alpaca IEX")
        self.assertEqual(payloads["alpaca:SPY"]["price"], 500.25)

    def test_fetch_candles_normalizes_alpaca_bars(self) -> None:
        """Verify Alpaca bars normalize into standard candles."""
        captured = []
        instrument = AlpacaInstrument("AAPL", "AAPL")

        def fake_fetch(_base_url, path, params):
            captured.append((path, params))
            return {
                "bars": {
                    "AAPL": [
                        {
                            "t": "2026-04-28T19:55:00Z",
                            "o": 200.0,
                            "h": 202.0,
                            "l": 199.5,
                            "c": 201.25,
                            "v": 12345,
                        }
                    ]
                }
            }

        with patch("terminal_ticker.alpaca_provider._fetch_json", side_effect=fake_fetch):
            candles = fetch_candles(instrument, interval="5m", limit=40)

        self.assertEqual(captured[0][0], "/v2/stocks/bars")
        self.assertEqual(captured[0][1]["symbols"], "AAPL")
        self.assertEqual(captured[0][1]["timeframe"], "5Min")
        self.assertEqual(candles[0].symbol_key, "alpaca:AAPL")
        self.assertEqual(candles[0].open_time_ms, 1777406100000)
        self.assertEqual(candles[0].open, 200.0)
        self.assertEqual(candles[0].close, 201.25)

    def test_search_assets_filters_cached_asset_list(self) -> None:
        """Verify Alpaca asset search matches symbol and name."""
        with patch(
            "terminal_ticker.alpaca_provider._fetch_json",
            return_value=[
                {"symbol": "AAPL", "name": "Apple Inc.", "exchange": "NASDAQ", "tradable": True},
                {"symbol": "AAP", "name": "Advance Auto Parts", "exchange": "NYSE"},
                {"symbol": "MSFT", "name": "Microsoft Corporation", "exchange": "NASDAQ"},
            ],
        ):
            results = search_assets("apple")

        self.assertEqual([item.symbol for item in results], ["AAPL"])
        self.assertEqual(results[0].default_label, "AAPL")
        self.assertIn("Apple Inc.", results[0].display_text())


if __name__ == "__main__":
    unittest.main()
