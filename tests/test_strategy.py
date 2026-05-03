"""Test regime/context strategy research helpers."""
import unittest

from terminal_ticker.domain.price_action import Candle
from terminal_ticker.domain.strategy import (
    StrategyConfig,
    generate_signal,
    split_optimize_validate,
    walk_forward_outcomes,
    evaluate_outcomes,
)


def _series(
    *,
    count: int,
    start: float = 100.0,
    step: float = 0.5,
    wiggle: float = 0.1,
) -> tuple[Candle, ...]:
    """Create a compact synthetic OHLCV series."""
    candles = []
    price = start
    for index in range(count):
        price += step + (wiggle if index % 2 == 0 else -wiggle)
        open_ = price - step * 0.5
        close = price
        high = max(open_, close) + 0.35
        low = min(open_, close) - 0.35
        candles.append(
            Candle(
                symbol_key="USDT-FUTURES:BTCUSDT",
                open_time_ms=index * 300_000,
                open=open_,
                high=high,
                low=low,
                close=close,
                volume=1000 + index,
            )
        )
    return tuple(candles)


class StrategyTests(unittest.TestCase):
    """Group tests for regime/context signal research."""

    def test_generate_signal_detects_uptrend_as_long(self) -> None:
        """Verify directional trend context can produce a long signal."""
        config = StrategyConfig(window=30, horizon=4, min_confidence=0.35, trend_threshold=0.25)

        signal = generate_signal(_series(count=50, step=0.7), config)

        self.assertEqual(signal.side, "long")
        self.assertEqual(signal.regime, "trend")

    def test_generate_signal_detects_downtrend_as_short(self) -> None:
        """Verify directional trend context can produce a short signal."""
        config = StrategyConfig(window=30, horizon=4, min_confidence=0.35, trend_threshold=0.25)

        signal = generate_signal(_series(count=50, step=-0.7), config)

        self.assertEqual(signal.side, "short")
        self.assertEqual(signal.regime, "trend")

    def test_walk_forward_metrics_include_flat_and_active_counts(self) -> None:
        """Verify walk-forward outcomes can be summarized."""
        config = StrategyConfig(window=24, horizon=4, min_confidence=0.35, trend_threshold=0.25)
        outcomes = walk_forward_outcomes(_series(count=90, step=0.45), config)

        metrics = evaluate_outcomes(outcomes)

        self.assertGreater(metrics.observations, 0)
        self.assertEqual(metrics.observations, metrics.trades + metrics.flat_count)
        self.assertGreater(metrics.total_return, 0)

    def test_split_optimize_validate_uses_front_half_then_back_half(self) -> None:
        """Verify split validation produces out-of-sample metrics."""
        config = StrategyConfig(window=24, horizon=4)

        result = split_optimize_validate(_series(count=150, step=0.35), config)

        self.assertGreater(result.train.observations, 0)
        self.assertGreater(result.validation.observations, 0)
        self.assertGreaterEqual(result.validation.hit_rate, 0.5)


if __name__ == "__main__":
    unittest.main()
