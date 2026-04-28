"""Test deterministic price action analysis."""
import unittest

from terminal_ticker.price_action import Candle, analyze_price_action


def _candle(index: int, open_: float, high: float, low: float, close: float) -> Candle:
    """Create a compact candle fixture."""
    return Candle(
        symbol_key="USDT-FUTURES:BTCUSDT",
        open_time_ms=index * 300_000,
        open=open_,
        high=high,
        low=low,
        close=close,
        volume=1000,
    )


class PriceActionTests(unittest.TestCase):
    """Group tests for price action classification."""
    def test_breakout_above_recent_range_is_bullish(self) -> None:
        """Verify breakout above prior highs is bullish."""
        candles = tuple(
            _candle(index, 100 + index * 0.2, 103, 99, 101 + index * 0.1)
            for index in range(12)
        ) + (_candle(12, 102, 109, 101, 108),)

        state = analyze_price_action(candles)

        self.assertEqual(state.label, "breakout")
        self.assertEqual(state.bias, "bullish")
        self.assertEqual(state.marker, "BO+")
        self.assertIn("突破", state.reason)

    def test_range_detects_overlapping_recent_candles(self) -> None:
        """Verify overlapping candles produce a neutral range state."""
        candles = tuple(
            _candle(index, 100.0, 101.2, 99.6, 100.2 if index % 2 else 100.0)
            for index in range(16)
        )

        state = analyze_price_action(candles)

        self.assertEqual(state.label, "range")
        self.assertEqual(state.bias, "neutral")
        self.assertEqual(state.marker, "RG")

    def test_bullish_pullback_detects_retrace_inside_up_context(self) -> None:
        """Verify retrace after an up move is a bullish pullback."""
        candles = tuple(
            _candle(index, 100 + index, 102 + index, 99 + index, 101 + index)
            for index in range(10)
        ) + (
            _candle(10, 111, 112, 108, 109),
            _candle(11, 109, 110, 106, 107),
        )

        state = analyze_price_action(candles)

        self.assertEqual(state.label, "pullback")
        self.assertEqual(state.bias, "bullish")
        self.assertEqual(state.marker, "PB+")

    def test_uptrend_detects_directional_progress(self) -> None:
        """Verify directional progress produces a bullish trend."""
        candles = tuple(
            _candle(index, 100 + index, 102 + index, 99 + index, 101 + index)
            for index in range(12)
        )

        state = analyze_price_action(candles)

        self.assertEqual(state.label, "trend")
        self.assertEqual(state.bias, "bullish")
        self.assertEqual(state.marker, "TR+")

    def test_unavailable_when_too_few_candles(self) -> None:
        """Verify too few candles do not produce a signal."""
        state = analyze_price_action((_candle(1, 100, 101, 99, 100.5),))

        self.assertEqual(state.label, "unavailable")
        self.assertEqual(state.bias, "neutral")
        self.assertEqual(state.strength, 0)


if __name__ == "__main__":
    unittest.main()
