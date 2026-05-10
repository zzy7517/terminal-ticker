"""Test normalized candle primitives."""
import unittest

from tradex.domain.price_action import Candle


class CandleTests(unittest.TestCase):
    """Group tests for normalized OHLCV candles."""

    def test_candle_exposes_range_and_body(self) -> None:
        """Verify candle convenience properties stay provider-neutral."""
        candle = Candle("USDT-FUTURES:BTCUSDT", 1, 100, 103, 99, 101.5, 1000)

        self.assertEqual(candle.range, 4)
        self.assertEqual(candle.body, 1.5)

    def test_candle_rejects_impossible_high(self) -> None:
        """Verify high must contain open, low, and close."""
        with self.assertRaises(ValueError):
            Candle("USDT-FUTURES:BTCUSDT", 1, 100, 99, 98, 101, 1000)

    def test_candle_rejects_impossible_low(self) -> None:
        """Verify low must not exceed open, high, or close."""
        with self.assertRaises(ValueError):
            Candle("USDT-FUTURES:BTCUSDT", 1, 100, 103, 101, 99, 1000)


if __name__ == "__main__":
    unittest.main()
