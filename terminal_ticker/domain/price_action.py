"""文件用途：领域层，定义 K 线和确定性 price action 分析。"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone

MIN_CANDLES = 10


@dataclass(frozen=True)
class Candle:
    """说明：封装一根标准化 OHLCV K 线。"""
    symbol_key: str
    open_time_ms: int
    open: float
    high: float
    low: float
    close: float
    volume: float

    def __post_init__(self) -> None:
        """说明：在数据对象创建后校验字段合法性。"""
        if self.high < max(self.open, self.close, self.low):
            raise ValueError("candle high must be greater than or equal to open, low, and close")
        if self.low > min(self.open, self.close, self.high):
            raise ValueError("candle low must be less than or equal to open, high, and close")

    @property
    def range(self) -> float:
        """说明：返回 K 线最高价和最低价之间的范围。"""
        return self.high - self.low

    @property
    def body(self) -> float:
        """说明：返回 K 线实体大小。"""
        return abs(self.close - self.open)


@dataclass(frozen=True)
class PriceActionState:
    """说明：封装单个标的的确定性 price action 结果。"""
    label: str
    bias: str
    marker: str
    reason: str
    strength: int
    updated_at: datetime = field(default_factory=lambda: datetime.now(timezone.utc))
    error: str | None = None

    @classmethod
    def unavailable(cls, reason: str) -> "PriceActionState":
        """说明：构造一个不可用的标准结果。"""
        return cls(
            label="unavailable",
            bias="neutral",
            marker="",
            reason=reason,
            strength=0,
            error=reason,
        )

    def is_available(self) -> bool:
        """说明：判断分析结果是否可展示。"""
        return self.label != "unavailable" and bool(self.marker)

    def is_stale(self, stale_after_seconds: int, *, now: datetime | None = None) -> bool:
        """说明：判断当前数据是否超过新鲜度阈值。"""
        if now is None:
            now = datetime.now(timezone.utc)
        return (now - self.updated_at).total_seconds() > stale_after_seconds


def _average(values: list[float]) -> float:
    """说明：计算非空数值列表的算术平均值。"""
    return sum(values) / len(values)


def _direction(candles: tuple[Candle, ...], width: int = 8) -> float:
    """说明：计算近期 K 线收盘价推进方向。"""
    if len(candles) <= width:
        return candles[-1].close - candles[0].close
    return candles[-1].close - candles[-width].close


def _is_range(candles: tuple[Candle, ...]) -> bool:
    """说明：判断近期 K 线是否处于重叠震荡区间。"""
    recent = candles[-8:]
    total_range = max(candle.high for candle in recent) - min(candle.low for candle in recent)
    avg_range = _average([max(candle.range, 0.0000001) for candle in recent])
    close_progress = abs(recent[-1].close - recent[0].close)
    return total_range <= avg_range * 2.4 and close_progress <= avg_range * 0.9


def analyze_price_action(candles: tuple[Candle, ...]) -> PriceActionState:
    """说明：把近期 K 线分类为紧凑的 price action 状态。"""
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
