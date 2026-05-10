"""文件用途：领域层，保存报价状态并生成 UI 展示标签。"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any

from .price_action import Candle


def _to_float(raw_value: Any) -> float | None:
    """说明：把原始报价字段转换成浮点数。"""
    if raw_value in (None, ""):
        return None
    try:
        return float(raw_value)
    except (TypeError, ValueError):
        return None


def _to_int(raw_value: Any) -> int | None:
    """说明：把原始报价字段转换成整数。"""
    if raw_value in (None, ""):
        return None
    try:
        return int(raw_value)
    except (TypeError, ValueError):
        return None


def _coalesce(new_value: Any, old_value: Any) -> Any:
    """说明：新值缺失时保留旧值。"""
    return old_value if new_value is None else new_value


def _compact_number(value: float | int | None) -> str:
    """说明：把大数字格式化为 K、M、B 简写。"""
    if value is None:
        return "-"
    number = float(value)
    absolute = abs(number)
    if absolute >= 1_000_000_000:
        return f"{number / 1_000_000_000:.2f}B"
    if absolute >= 1_000_000:
        return f"{number / 1_000_000:.2f}M"
    if absolute >= 1_000:
        return f"{number / 1_000:.2f}K"
    if float(number).is_integer():
        return f"{int(number)}"
    return f"{number:.2f}"


def _format_signed(value: float | None, suffix: str = "") -> str:
    """说明：格式化带正负号的数值。"""
    if value is None:
        return "-"
    return f"{value:+.2f}{suffix}"


def _status_label(raw_market_hours: Any) -> str:
    """说明：把 market-hours 代码转换成短状态。"""
    market_hours = _to_int(raw_market_hours)
    if market_hours == 0:
        return "pre"
    if market_hours == 1:
        return "open"
    if market_hours == 2:
        return "post"
    return "live"


def _age_label(last_update_at: datetime | None, *, now: datetime | None = None) -> str:
    """说明：格式化距离最近报价更新的时间。"""
    if last_update_at is None:
        return "waiting"
    if now is None:
        now = datetime.now(timezone.utc)
    elapsed_ms = max(0, int((now - last_update_at).total_seconds() * 1000))
    if elapsed_ms < 1000:
        return f"{elapsed_ms}ms"
    if elapsed_ms < 10_000:
        return f"{elapsed_ms / 1000:.1f}s"
    elapsed = elapsed_ms // 1000
    if elapsed < 60:
        return f"{elapsed}s"
    minutes, seconds = divmod(elapsed, 60)
    return f"{minutes}m{seconds:02d}s"


@dataclass
class QuoteState:
    """说明：封装单个标的的报价状态和展示标签。"""
    symbol: str
    display_name: str
    price: float | None = None
    change: float | None = None
    change_percent: float | None = None
    previous_close: float | None = None
    day_high: float | None = None
    day_low: float | None = None
    volume: float | None = None
    currency: str = ""
    exchange: str = ""
    status: str = "waiting"
    last_trade_epoch: int | None = None
    last_update_at: datetime | None = None
    update_count: int = 0
    last_error: str | None = None
    candles: tuple[Candle, ...] = tuple()
    thumbnail_candles: tuple[Candle, ...] = tuple()
    multi_timeframe_candles: dict[str, tuple[Candle, ...]] = None

    def __post_init__(self) -> None:
        """说明：初始化可变字段的默认容器。"""
        if self.multi_timeframe_candles is None:
            self.multi_timeframe_candles = {}

    @classmethod
    def placeholder(cls, symbol: str) -> "QuoteState":
        """说明：创建等待行情到达前的占位报价状态。"""
        return cls(symbol=symbol, display_name=symbol)

    def apply_payload(self, payload: dict[str, Any]) -> None:
        """说明：把实时行情载荷应用到报价状态。"""
        self.display_name = payload.get("short_name") or self.display_name or self.symbol
        self.price = _coalesce(_to_float(payload.get("price")), self.price)
        self.change = _to_float(payload.get("change"))
        self.change_percent = _to_float(payload.get("change_percent"))
        self.previous_close = _coalesce(
            _to_float(payload.get("previous_close")),
            self.previous_close,
        )
        self.day_high = _coalesce(_to_float(payload.get("day_high")), self.day_high)
        self.day_low = _coalesce(_to_float(payload.get("day_low")), self.day_low)
        self.volume = _coalesce(_to_float(payload.get("day_volume")), self.volume)
        self.currency = str(payload.get("currency") or self.currency or "")
        self.exchange = str(payload.get("exchange") or self.exchange or "")
        if isinstance(payload.get("status"), str) and payload.get("status"):
            self.status = str(payload["status"]).lower()
        else:
            self.status = _status_label(payload.get("market_hours"))
        self.last_trade_epoch = _coalesce(
            _to_int(payload.get("time") or payload.get("ts")),
            self.last_trade_epoch,
        )
        self.last_update_at = datetime.now(timezone.utc)
        self.update_count += 1
        self.last_error = None

    def apply_snapshot(self, payload: dict[str, Any]) -> None:
        """说明：把初始快照载荷应用到报价状态。"""
        self.display_name = payload.get("display_name") or self.display_name or self.symbol
        self.price = _coalesce(_to_float(payload.get("price")), self.price)
        self.change = _to_float(payload.get("change"))
        self.change_percent = _to_float(payload.get("change_percent"))
        self.previous_close = _coalesce(
            _to_float(payload.get("previous_close")),
            self.previous_close,
        )
        self.day_high = _coalesce(_to_float(payload.get("day_high")), self.day_high)
        self.day_low = _coalesce(_to_float(payload.get("day_low")), self.day_low)
        self.volume = _coalesce(_to_float(payload.get("volume")), self.volume)
        self.currency = str(payload.get("currency") or self.currency or "")
        self.exchange = str(payload.get("exchange") or self.exchange or "")
        self.status = "snap" if self.status == "waiting" else self.status
        self.last_update_at = datetime.now(timezone.utc)
        self.update_count += 1
        self.last_error = None

    def mark_error(self, detail: str) -> None:
        """说明：记录最近一次报价错误。"""
        self.last_error = detail

    def apply_candles(
        self,
        *,
        candles: tuple[Candle, ...] = tuple(),
        thumbnail_candles: tuple[Candle, ...] | None = None,
        multi_timeframe_candles: dict[str, tuple[Candle, ...]] | None = None,
    ) -> None:
        """说明：把图表 K 线写入报价状态。"""
        self.candles = candles
        if thumbnail_candles is not None:
            self.thumbnail_candles = thumbnail_candles
        if multi_timeframe_candles is not None:
            self.multi_timeframe_candles = dict(multi_timeframe_candles)

    def is_stale(self, stale_after_seconds: int, *, now: datetime | None = None) -> bool:
        """说明：判断当前数据是否超过新鲜度阈值。"""
        if self.last_update_at is None:
            return True
        if now is None:
            now = datetime.now(timezone.utc)
        return (now - self.last_update_at).total_seconds() > stale_after_seconds

    def price_label(self) -> str:
        """说明：格式化当前价格。"""
        return "-" if self.price is None else f"{self.price:.2f}"

    def change_label(self) -> str:
        """说明：格式化绝对涨跌。"""
        return _format_signed(self.change)

    def percent_label(self) -> str:
        """说明：格式化百分比涨跌。"""
        return _format_signed(self.change_percent, "%")

    def volume_label(self) -> str:
        """说明：格式化成交量。"""
        return _compact_number(self.volume)

    def age_label(self, *, now: datetime | None = None) -> str:
        """说明：格式化距离最近更新的时间。"""
        return _age_label(self.last_update_at, now=now)
