"""文件用途：Paper trading 撮合引擎，基于 1m K 线判定 fill。"""
from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Callable, Iterable

from ..domain.price_action import Candle
from .models import (
    Fill,
    FillKind,
    Trade,
    TradeDirection,
    TradeStatus,
)
from .store import TradeStore

LOGGER = logging.getLogger(__name__)

DEFAULT_FILL_INTERVAL = "1m"


@dataclass(frozen=True)
class FillEvent:
    """说明：broker 撮合产生的一次状态变更事件，供上层广播。"""

    trade_id: int
    kind: FillKind
    price: float
    quantity: float
    filled_at_ms: int
    trigger_reason: str
    trade_after: Trade


class PaperBroker:
    """说明：消费 1m K 线，对 planned/open 订单判定 fill 并推进状态。

    撮合规则（基于单根 K 线 high/low）：
    - planned 限价单：K 线穿过 intent_price → 记 ENTRY fill，status → open
    - open 做多：low ≤ stop_price → STOP fill；high ≥ target → TARGET fill
    - open 做空：high ≥ stop_price → STOP fill；low ≤ target → TARGET fill
    同根 K 线 stop 与 target 同时触发时，保守假设 stop 先触发（安全优先）。
    市价单（intent_price 为 None 且 status=planned）用 K 线 open 价格立即 fill。
    """

    def __init__(
        self,
        store: TradeStore,
        *,
        fill_source: str = "simulated",
        on_fill: Callable[[FillEvent], None] | None = None,
    ) -> None:
        """说明：初始化运行状态。"""
        self.store = store
        self.fill_source = fill_source
        self._on_fill = on_fill

    def process_candle(self, candle: Candle) -> tuple[FillEvent, ...]:
        """说明：对某标的某根 1m K 线，撮合相关的 planned/open 订单。"""
        events: list[FillEvent] = []
        trades = self.store.list_trades(
            instrument_key=candle.symbol_key,
            statuses=[TradeStatus.PLANNED, TradeStatus.OPEN],
        )
        for trade in trades:
            events.extend(self._process_trade(trade, candle))
        return tuple(events)

    def process_candles(self, candles: Iterable[Candle]) -> tuple[FillEvent, ...]:
        """说明：按时间顺序批量撮合多根 K 线。"""
        events: list[FillEvent] = []
        for candle in sorted(candles, key=lambda c: c.open_time_ms):
            events.extend(self.process_candle(candle))
        return tuple(events)

    def _process_trade(self, trade: Trade, candle: Candle) -> list[FillEvent]:
        """说明：撮合单笔订单与单根 K 线。"""
        if trade.status is TradeStatus.PLANNED:
            return self._fill_entry_if_touched(trade, candle)
        if trade.status is TradeStatus.OPEN:
            return self._fill_exit_if_touched(trade, candle)
        return []

    def _fill_entry_if_touched(self, trade: Trade, candle: Candle) -> list[FillEvent]:
        """说明：planned 订单尝试 entry fill。"""
        intent = trade.intent_price
        if intent is None:
            # 市价单：按 K 线 open 立即 fill。
            return self._record_entry(trade, candle, price=candle.open, reason="market order")

        if trade.direction is TradeDirection.LONG:
            if candle.low <= intent <= candle.high:
                fill_price = min(intent, candle.open) if candle.open <= intent else intent
                return self._record_entry(
                    trade, candle, price=fill_price, reason="limit touched (long)"
                )
            return []

        if candle.low <= intent <= candle.high:
            fill_price = max(intent, candle.open) if candle.open >= intent else intent
            return self._record_entry(
                trade, candle, price=fill_price, reason="limit touched (short)"
            )
        return []

    def _record_entry(
        self,
        trade: Trade,
        candle: Candle,
        *,
        price: float,
        reason: str,
    ) -> list[FillEvent]:
        fill = self.store.record_fill(
            trade_id=trade.id,
            kind=FillKind.ENTRY,
            price=float(price),
            quantity=trade.size,
            trigger_reason=reason,
            fill_source=self.fill_source,
            filled_at_ms=candle.open_time_ms,
        )
        updated = self.store.mark_open(trade.id, opened_at_ms=candle.open_time_ms)
        event = self._emit_event(fill, updated)
        return [event]

    def _fill_exit_if_touched(self, trade: Trade, candle: Candle) -> list[FillEvent]:
        """说明：open 订单尝试 stop 或 target fill。"""
        entry_price = trade.average_entry_price
        if entry_price is None:
            LOGGER.warning("open trade %s has no entry fill, skipping exit eval", trade.id)
            return []

        stop_hit = self._stop_hit(trade, candle)
        target_hit, target_price = self._target_hit(trade, candle)

        if stop_hit and target_hit:
            # 同根 K 线 stop+target 双触发：保守以 stop 为准（不给自己乐观评估）。
            return [self._close_via(trade, candle, entry_price, FillKind.STOP, trade.stop_price, "stop+target same bar, stop wins")]
        if stop_hit and trade.stop_price is not None:
            return [self._close_via(trade, candle, entry_price, FillKind.STOP, trade.stop_price, "stop hit")]
        if target_hit and target_price is not None:
            return [self._close_via(trade, candle, entry_price, FillKind.TARGET, target_price, "target hit")]
        return []

    def _stop_hit(self, trade: Trade, candle: Candle) -> bool:
        stop = trade.stop_price
        if stop is None:
            return False
        if trade.direction is TradeDirection.LONG:
            return candle.low <= stop
        return candle.high >= stop

    def _target_hit(self, trade: Trade, candle: Candle) -> tuple[bool, float | None]:
        """说明：取最近的未到达目标位（多头取最低目标，空头取最高目标）。"""
        if not trade.target_prices:
            return (False, None)
        if trade.direction is TradeDirection.LONG:
            target = min(trade.target_prices)
            return (candle.high >= target, target)
        target = max(trade.target_prices)
        return (candle.low <= target, target)

    def _close_via(
        self,
        trade: Trade,
        candle: Candle,
        entry_price: float,
        kind: FillKind,
        price: float | None,
        reason: str,
    ) -> FillEvent:
        """说明：登记 stop/target fill 并把订单平仓。"""
        if price is None:
            raise ValueError("exit price required")
        fill = self.store.record_fill(
            trade_id=trade.id,
            kind=kind,
            price=float(price),
            quantity=trade.size,
            trigger_reason=reason,
            fill_source=self.fill_source,
            filled_at_ms=candle.open_time_ms,
        )
        realized = (float(price) - entry_price) * trade.size * trade.direction.sign
        updated = self.store.mark_closed(
            trade.id,
            realized_pnl=realized,
            closed_at_ms=candle.open_time_ms,
        )
        return self._emit_event(fill, updated)

    def _emit_event(self, fill: Fill, trade_after: Trade) -> FillEvent:
        event = FillEvent(
            trade_id=fill.trade_id,
            kind=fill.kind,
            price=fill.price,
            quantity=fill.quantity,
            filled_at_ms=fill.filled_at_ms,
            trigger_reason=fill.trigger_reason,
            trade_after=trade_after,
        )
        if self._on_fill is not None:
            try:
                self._on_fill(event)
            except Exception:
                LOGGER.exception("paper broker on_fill callback failed")
        return event
