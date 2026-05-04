"""Test Bitget payload normalization."""
import unittest
from unittest.mock import patch

from mytradebot.market_data.bitget import (
    SPOT,
    BitgetInstrument,
    _api_granularity,
    _normalize_candle_row,
    _normalize_ticker_payload,
    fetch_candles,
    search_instruments,
)


class BitgetTests(unittest.TestCase):
    """Group tests for BitgetTests."""
    def test_normalize_futures_ticker_payload(self) -> None:
        """Verify normalize futures ticker payload."""
        instrument = BitgetInstrument(
            symbol="XAUUSDT",
            inst_type="USDT-FUTURES",
            label="XAU",
            base_asset="XAU",
            quote_asset="USDT",
            market_kind="perp",
        )
        payload = _normalize_ticker_payload(
            {
                "lastPr": "4752.88",
                "open24h": "4784.62",
                "high24h": "4793.61",
                "low24h": "4668.02",
                "change24h": "-0.00663",
                "baseVolume": "80302.63",
                "ts": "1776846198485",
            },
            instrument,
        )

        self.assertEqual(payload["id"], "USDT-FUTURES:XAUUSDT")
        self.assertEqual(payload["short_name"], "XAU")
        self.assertAlmostEqual(payload["price"], 4752.88)
        self.assertAlmostEqual(payload["change"], -31.74, places=2)
        self.assertAlmostEqual(payload["change_percent"], -0.663, places=3)
        self.assertEqual(payload["status"], "perp")

    def test_normalize_candle_row(self) -> None:
        """Verify normalize candle row."""
        candle = _normalize_candle_row(
            "USDT-FUTURES:XAUUSDT",
            [
                "1695835800000",
                "26210.5",
                "26220.0",
                "26194.5",
                "26200.0",
                "26.26",
                "687897.63",
            ],
        )

        self.assertEqual(candle.symbol_key, "USDT-FUTURES:XAUUSDT")
        self.assertEqual(candle.open_time_ms, 1695835800000)
        self.assertEqual(candle.open, 26210.5)
        self.assertEqual(candle.high, 26220.0)
        self.assertEqual(candle.low, 26194.5)
        self.assertEqual(candle.close, 26200.0)
        self.assertEqual(candle.volume, 26.26)

    def test_api_granularity_maps_non_default_intervals(self) -> None:
        """Verify Bitget candle intervals map beyond the 5m default."""
        self.assertEqual(_api_granularity(SPOT, "15m"), "15min")
        self.assertEqual(_api_granularity(SPOT, "4H"), "4h")
        self.assertEqual(_api_granularity("USDT-FUTURES", "15m"), "15m")
        self.assertEqual(_api_granularity("USDT-FUTURES", "4H"), "4H")

    def test_fetch_candles_after_includes_time_window(self) -> None:
        """Verify incremental Bitget candle fetches include start and end time."""
        instrument = BitgetInstrument(
            symbol="BTCUSDT",
            inst_type="USDT-FUTURES",
            label="BTC",
            base_asset="BTC",
            quote_asset="USDT",
            market_kind="perp",
        )

        with patch(
            "mytradebot.market_data.bitget._fetch_json",
            return_value={
                "code": "00000",
                "data": [["1695835800000", "1", "2", "0.5", "1.5", "10"]],
            },
        ) as fetch_json:
            candles = fetch_candles(
                instrument,
                interval="5m",
                limit=40,
                after_open_time_ms=1695835500000,
            )

        params = fetch_json.call_args.args[1]
        self.assertEqual(params["startTime"], "1695835500001")
        self.assertIn("endTime", params)
        self.assertEqual(candles[0].open_time_ms, 1695835800000)

    def test_fetch_candles_before_uses_history_window(self) -> None:
        """Verify older Bitget candle fetches request the window before cached data."""
        instrument = BitgetInstrument(
            symbol="BTCUSDT",
            inst_type="USDT-FUTURES",
            label="BTC",
            base_asset="BTC",
            quote_asset="USDT",
            market_kind="perp",
        )

        with patch(
            "mytradebot.market_data.bitget._fetch_json",
            return_value={
                "code": "00000",
                "data": [
                    ["1695835200000", "1", "2", "0.5", "1.5", "10"],
                    ["1695835500000", "1.5", "2", "1", "1.8", "11"],
                    ["1695835800000", "1.8", "2", "1.7", "1.9", "12"],
                ],
            },
        ) as fetch_json:
            candles = fetch_candles(
                instrument,
                interval="5m",
                limit=2,
                before_open_time_ms=1695835800000,
            )

        self.assertEqual(fetch_json.call_args.args[0], "/api/v2/mix/market/history-candles")
        params = fetch_json.call_args.args[1]
        self.assertEqual(params["endTime"], "1695835799999")
        self.assertEqual(params["limit"], "2")
        self.assertEqual([candle.open_time_ms for candle in candles], [1695835200000, 1695835500000])

    def test_fetch_spot_recent_uses_1000_limit_endpoint(self) -> None:
        """Verify initial Bitget spot fetches can request the full chart window."""
        instrument = BitgetInstrument(
            symbol="BTCUSDT",
            inst_type=SPOT,
            label="BTC",
            base_asset="BTC",
            quote_asset="USDT",
            market_kind="spot",
        )

        with patch(
            "mytradebot.market_data.bitget._fetch_json",
            return_value={"code": "00000", "data": []},
        ) as fetch_json:
            fetch_candles(instrument, interval="5m", limit=1000)

        self.assertEqual(fetch_json.call_args.args[0], "/api/v2/spot/market/candles")
        self.assertEqual(fetch_json.call_args.args[1]["limit"], "1000")

    def test_search_instruments_filters_catalog(self) -> None:
        """Verify Bitget search returns matching spot and futures instruments."""
        catalog = {
            ("SPOT", "BTCUSDT"): BitgetInstrument(
                "BTCUSDT",
                "SPOT",
                "BTCUSDT",
                "BTC",
                "USDT",
                "spot",
            ),
            ("USDT-FUTURES", "BTCUSDT"): BitgetInstrument(
                "BTCUSDT",
                "USDT-FUTURES",
                "BTCUSDT",
                "BTC",
                "USDT",
                "perp",
            ),
            ("USDT-FUTURES", "ETHUSDT"): BitgetInstrument(
                "ETHUSDT",
                "USDT-FUTURES",
                "ETHUSDT",
                "ETH",
                "USDT",
                "perp",
            ),
        }

        with patch("mytradebot.market_data.bitget.load_instrument_catalog", return_value=catalog):
            results = search_instruments("btc")

        self.assertEqual([item.key for item in results], ["SPOT:BTCUSDT", "USDT-FUTURES:BTCUSDT"])


if __name__ == "__main__":
    unittest.main()
