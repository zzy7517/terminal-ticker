"""Test Alpaca provider normalization and search."""
import unittest
from unittest.mock import patch

from mytradebot.market_data.alpaca import (
    AlpacaInstrument,
    clear_asset_cache,
    fetch_candles,
    fetch_snapshot_payloads,
    resolve_instruments,
    search_assets,
)
from mytradebot.config import InstrumentConfig


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

        with patch("mytradebot.market_data.alpaca._fetch_json", side_effect=fake_fetch):
            payloads = fetch_snapshot_payloads(instruments)

        self.assertEqual(calls[0][0], "/v2/stocks/snapshots")
        self.assertEqual(calls[0][1]["symbols"], "AAPL,SPY")
        self.assertEqual(payloads["alpaca:AAPL"]["price"], 201.5)
        self.assertAlmostEqual(payloads["alpaca:AAPL"]["change"], 1.25)
        self.assertAlmostEqual(payloads["alpaca:AAPL"]["change_percent"], 0.6242, places=4)
        self.assertEqual(payloads["alpaca:AAPL"]["exchange"], "Alpaca IEX")
        self.assertEqual(payloads["alpaca:SPY"]["price"], 500.25)

    def test_fetch_snapshot_payloads_merges_extended_hours_day_stats(self) -> None:
        """Verify pre-/post-market 1m bars expand day_high/low/volume beyond RTH."""
        instruments = (AlpacaInstrument("AAPL", "AAPL"),)
        calls: list[tuple[str, dict[str, str]]] = []

        def fake_fetch(_base_url, path, params):
            calls.append((path, params))
            if path == "/v2/stocks/snapshots":
                return {
                    "snapshots": {
                        "AAPL": {
                            "latestTrade": {"p": 207.0, "t": "2026-04-28T11:55:00Z"},
                            "dailyBar": {"h": 202.0, "l": 199.8, "v": 100000},
                            "prevDailyBar": {"c": 200.0},
                        },
                    }
                }
            # /v2/stocks/bars -- return a pre-market high above the RTH high.
            return {
                "bars": {
                    "AAPL": [
                        {"t": "2026-04-28T08:30:00Z", "h": 205.5, "l": 198.0, "v": 4500},
                        {"t": "2026-04-28T11:00:00Z", "h": 203.0, "l": 200.5, "v": 6000},
                    ]
                }
            }

        with patch("mytradebot.market_data.alpaca._fetch_json", side_effect=fake_fetch):
            payloads = fetch_snapshot_payloads(instruments)

        bars_calls = [call for call in calls if call[0] == "/v2/stocks/bars"]
        self.assertEqual(len(bars_calls), 1)
        self.assertEqual(bars_calls[0][1]["timeframe"], "1Min")
        self.assertEqual(bars_calls[0][1]["symbols"], "AAPL")

        payload = payloads["alpaca:AAPL"]
        # latestTrade@207 beats the pre-market high of 205.5, so day_high reflects it.
        self.assertEqual(payload["day_high"], 207.0)
        # Pre-market low of 198.0 is below the RTH low of 199.8.
        self.assertEqual(payload["day_low"], 198.0)
        # day_volume should be the 1m aggregate, not the RTH-only dailyBar volume.
        self.assertEqual(payload["day_volume"], 10500)
        self.assertEqual(payload["volume"], 10500)

    def test_fetch_snapshot_payloads_falls_back_when_bars_fetch_fails(self) -> None:
        """Verify snapshot endpoint still returns RTH-only stats if bars fetch errors."""
        instruments = (AlpacaInstrument("AAPL", "AAPL"),)

        def fake_fetch(_base_url, path, _params):
            if path == "/v2/stocks/snapshots":
                return {
                    "snapshots": {
                        "AAPL": {
                            "latestTrade": {"p": 201.5, "t": "2026-04-28T19:55:00Z"},
                            "dailyBar": {"h": 202.0, "l": 199.8, "v": 123456},
                            "prevDailyBar": {"c": 200.25},
                        },
                    }
                }
            raise RuntimeError("bars endpoint down")

        with patch("mytradebot.market_data.alpaca._fetch_json", side_effect=fake_fetch):
            payloads = fetch_snapshot_payloads(instruments)

        payload = payloads["alpaca:AAPL"]
        # Falls back to RTH dailyBar, but latestTrade still widens day_high if higher.
        self.assertEqual(payload["day_high"], 202.0)
        self.assertEqual(payload["day_low"], 199.8)
        self.assertEqual(payload["day_volume"], 123456)

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

        with patch("mytradebot.market_data.alpaca._fetch_json", side_effect=fake_fetch):
            candles = fetch_candles(instrument, interval="5m", limit=40)

        self.assertEqual(captured[0][0], "/v2/stocks/bars")
        self.assertEqual(captured[0][1]["symbols"], "AAPL")
        self.assertEqual(captured[0][1]["timeframe"], "5Min")
        self.assertEqual(candles[0].symbol_key, "alpaca:AAPL")
        self.assertEqual(candles[0].open_time_ms, 1777406100000)
        self.assertEqual(candles[0].open, 200.0)
        self.assertEqual(candles[0].close, 201.25)

    def test_fetch_candles_recent_requests_newest_page_first(self) -> None:
        """Verify recent Alpaca fetches do not cache an old paginated first page."""
        captured = []
        instrument = AlpacaInstrument("AAPL", "AAPL")

        def fake_fetch(_base_url, path, params):
            captured.append((path, params))
            return {
                "bars": {
                    "AAPL": [
                        {
                            "t": "2026-04-30T19:00:00Z",
                            "o": 204.0,
                            "h": 206.0,
                            "l": 203.5,
                            "c": 205.25,
                            "v": 13000,
                        },
                        {
                            "t": "2026-04-30T18:00:00Z",
                            "o": 203.0,
                            "h": 205.0,
                            "l": 202.5,
                            "c": 204.25,
                            "v": 12000,
                        },
                    ]
                },
                "next_page_token": "older-page",
            }

        with patch("mytradebot.market_data.alpaca._fetch_json", side_effect=fake_fetch):
            candles = fetch_candles(instrument, interval="1H", limit=60)

        self.assertEqual(captured[0][0], "/v2/stocks/bars")
        self.assertEqual(captured[0][1]["sort"], "desc")
        self.assertEqual(captured[0][1]["limit"], "60")
        self.assertEqual([candle.open_time_ms for candle in candles], [1777572000000, 1777575600000])

    def test_fetch_candles_before_requests_descending_history(self) -> None:
        """Verify older Alpaca candle fetches request the page before cached data."""
        captured = []
        instrument = AlpacaInstrument("AAPL", "AAPL")

        def fake_fetch(_base_url, path, params):
            captured.append((path, params))
            return {
                "bars": {
                    "AAPL": [
                        {
                            "t": "2026-04-28T19:50:00Z",
                            "o": 199.0,
                            "h": 201.0,
                            "l": 198.5,
                            "c": 200.25,
                            "v": 12000,
                        }
                    ]
                }
            }

        with patch("mytradebot.market_data.alpaca._fetch_json", side_effect=fake_fetch):
            candles = fetch_candles(
                instrument,
                interval="5m",
                limit=200,
                before_open_time_ms=1777406400000,
            )

        self.assertEqual(captured[0][0], "/v2/stocks/bars")
        self.assertEqual(captured[0][1]["limit"], "200")
        self.assertEqual(captured[0][1]["sort"], "desc")
        self.assertEqual(captured[0][1]["end"], "2026-04-28T19:59:59.999000Z")
        self.assertEqual(candles[0].open_time_ms, 1777405800000)

    def test_search_assets_filters_cached_asset_list(self) -> None:
        """Verify Alpaca asset search matches symbol and name."""
        with patch(
            "mytradebot.market_data.alpaca._fetch_json",
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
