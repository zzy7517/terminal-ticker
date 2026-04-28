"""Test Bitget payload normalization."""
import unittest

from terminal_ticker.bitget import BitgetInstrument, _normalize_candle_row, _normalize_ticker_payload


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


if __name__ == "__main__":
    unittest.main()
