"""Analyze OHLCV candles into compact price action state."""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone

MIN_CANDLES = 10


@dataclass(frozen=True)
class Candle:
    """Represent one OHLCV candle."""
    symbol_key: str
    open_time_ms: int
    open: float
    high: float
    low: float
    close: float
    volume: float

    def __post_init__(self) -> None:
        """Reject impossible OHLC values early."""
        if self.high < max(self.open, self.close, self.low):
            raise ValueError("candle high must be greater than or equal to open, low, and close")
        if self.low > min(self.open, self.close, self.high):
            raise ValueError("candle low must be less than or equal to open, high, and close")

    @property
    def range(self) -> float:
        """Return candle high-low range."""
        return self.high - self.low

    @property
    def body(self) -> float:
        """Return absolute candle body size."""
        return abs(self.close - self.open)


@dataclass(frozen=True)
class PriceActionState:
    """Describe derived market context for one symbol."""
    label: str
    bias: str
    marker: str
    reason: str
    strength: int
    updated_at: datetime = field(default_factory=lambda: datetime.now(timezone.utc))
    error: str | None = None

    @classmethod
    def unavailable(cls, reason: str) -> "PriceActionState":
        """Build a neutral unavailable state."""
        return cls(
            label="unavailable",
            bias="neutral",
            marker="",
            reason=reason,
            strength=0,
            error=reason,
        )

    def is_available(self) -> bool:
        """Return whether this state can be shown as active analysis."""
        return self.label != "unavailable" and bool(self.marker)

    def is_stale(self, stale_after_seconds: int, *, now: datetime | None = None) -> bool:
        """Return whether this analysis is older than the freshness threshold."""
        if now is None:
            now = datetime.now(timezone.utc)
        return (now - self.updated_at).total_seconds() > stale_after_seconds


def _average(values: list[float]) -> float:
    """Return the arithmetic average for a non-empty list."""
    return sum(values) / len(values)


def _direction(candles: tuple[Candle, ...], width: int = 8) -> float:
    """Measure close-to-close progress over recent candles."""
    if len(candles) <= width:
        return candles[-1].close - candles[0].close
    return candles[-1].close - candles[-width].close


def _is_range(candles: tuple[Candle, ...]) -> bool:
    """Detect overlapping recent candles with limited close progress."""
    recent = candles[-8:]
    total_range = max(candle.high for candle in recent) - min(candle.low for candle in recent)
    avg_range = _average([max(candle.range, 0.0000001) for candle in recent])
    close_progress = abs(recent[-1].close - recent[0].close)
    return total_range <= avg_range * 2.4 and close_progress <= avg_range * 0.9


def analyze_price_action(candles: tuple[Candle, ...]) -> PriceActionState:
    """Classify recent candles into a compact price action state."""
    ordered = tuple(sorted(candles, key=lambda candle: candle.open_time_ms))
    if len(ordered) < MIN_CANDLES:
        return PriceActionState.unavailable(f"Need at least {MIN_CANDLES} candles.")

    latest = ordered[-1]
    previous = ordered[:-1]
    recent = ordered[-10:]
    previous_high = max(candle.high for candle in previous[-9:])
    previous_low = min(candle.low for candle in previous[-9:])
    avg_range = _average([max(candle.range, 0.0000001) for candle in recent])

    if latest.close > previous_high and latest.close > latest.open:
        return PriceActionState(
            label="breakout",
            bias="bullish",
            marker="BO+",
            reason="突破近期区间",
            strength=min(100, int(70 + (latest.close - previous_high) / avg_range * 20)),
        )
    if latest.close < previous_low and latest.close < latest.open:
        return PriceActionState(
            label="breakout",
            bias="bearish",
            marker="BO-",
            reason="跌破近期区间",
            strength=min(100, int(70 + (previous_low - latest.close) / avg_range * 20)),
        )

    progress = _direction(ordered)
    context_progress = ordered[-3].close - ordered[-10].close
    last_two_pull_back = ordered[-1].close < ordered[-2].close < ordered[-3].close
    last_two_push_up = ordered[-1].close > ordered[-2].close > ordered[-3].close
    if context_progress > avg_range * 2.0 and last_two_pull_back:
        return PriceActionState(
            label="pullback",
            bias="bullish",
            marker="PB+",
            reason="上升回调",
            strength=62,
        )
    if context_progress < -avg_range * 2.0 and last_two_push_up:
        return PriceActionState(
            label="pullback",
            bias="bearish",
            marker="PB-",
            reason="下降回调",
            strength=62,
        )

    if _is_range(ordered):
        return PriceActionState(
            label="range",
            bias="neutral",
            marker="RG",
            reason="K线重叠震荡",
            strength=42,
        )

    if progress > avg_range * 1.4:
        return PriceActionState(
            label="trend",
            bias="bullish",
            marker="TR+",
            reason="收盘持续上行",
            strength=min(100, int(55 + progress / avg_range * 6)),
        )
    if progress < -avg_range * 1.4:
        return PriceActionState(
            label="trend",
            bias="bearish",
            marker="TR-",
            reason="收盘持续下行",
            strength=min(100, int(55 + abs(progress) / avg_range * 6)),
        )

    return PriceActionState(
        label="range",
        bias="neutral",
        marker="RG",
        reason="方向不明确",
        strength=35,
    )
