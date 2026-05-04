"""文件用途：Paper trading 领域模型，定义 Trade / Fill / Snapshot 数据类。"""
from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Any


class TradeDirection(str, Enum):
    """说明：交易方向。"""

    LONG = "long"
    SHORT = "short"

    @property
    def sign(self) -> int:
        """说明：long=+1, short=-1，用于 PnL 计算。"""
        return 1 if self is TradeDirection.LONG else -1


class TradeStatus(str, Enum):
    """说明：订单生命周期状态。"""

    PLANNED = "planned"
    OPEN = "open"
    CLOSED = "closed"
    CANCELLED = "cancelled"


class FillKind(str, Enum):
    """说明：成交类型。"""

    ENTRY = "entry"
    EXIT = "exit"
    STOP = "stop"
    TARGET = "target"


@dataclass(frozen=True)
class Snapshot:
    """说明：开单时冻结的多周期 OHLCV + 决策上下文。"""

    id: int
    instrument_key: str
    captured_at_ms: int
    payload: dict[str, Any]

    def to_payload(self) -> dict[str, Any]:
        """说明：转换为前端可消费载荷。"""
        return {
            "id": self.id,
            "instrumentKey": self.instrument_key,
            "capturedAtMs": self.captured_at_ms,
            "payload": self.payload,
        }


@dataclass(frozen=True)
class Fill:
    """说明：一次成交记录。"""

    id: int
    trade_id: int
    kind: FillKind
    price: float
    quantity: float
    filled_at_ms: int
    trigger_reason: str
    fill_source: str
    fees: float = 0.0
    external_order_id: str | None = None

    def to_payload(self) -> dict[str, Any]:
        """说明：转换为前端可消费载荷。"""
        return {
            "id": self.id,
            "tradeId": self.trade_id,
            "kind": self.kind.value,
            "price": self.price,
            "quantity": self.quantity,
            "filledAtMs": self.filled_at_ms,
            "triggerReason": self.trigger_reason,
            "fillSource": self.fill_source,
            "fees": self.fees,
            "externalOrderId": self.external_order_id,
        }


@dataclass(frozen=True)
class Trade:
    """说明：一笔虚拟订单的完整状态。"""

    id: int
    instrument_key: str
    direction: TradeDirection
    status: TradeStatus
    size: float
    intent_price: float | None
    stop_price: float | None
    target_prices: tuple[float, ...]
    opened_at_ms: int | None
    closed_at_ms: int | None
    realized_pnl: float
    reasoning_text: str
    session_id: str | None
    snapshot_id: int | None
    market_kind: str
    fill_source: str
    external_order_id: str | None
    created_at_ms: int
    updated_at_ms: int
    fills: tuple[Fill, ...] = field(default_factory=tuple)

    def to_payload(self, *, include_fills: bool = True) -> dict[str, Any]:
        """说明：转换为前端可消费载荷。"""
        payload: dict[str, Any] = {
            "id": self.id,
            "instrumentKey": self.instrument_key,
            "direction": self.direction.value,
            "status": self.status.value,
            "size": self.size,
            "intentPrice": self.intent_price,
            "stopPrice": self.stop_price,
            "targetPrices": list(self.target_prices),
            "openedAtMs": self.opened_at_ms,
            "closedAtMs": self.closed_at_ms,
            "realizedPnl": self.realized_pnl,
            "reasoningText": self.reasoning_text,
            "sessionId": self.session_id,
            "snapshotId": self.snapshot_id,
            "marketKind": self.market_kind,
            "fillSource": self.fill_source,
            "externalOrderId": self.external_order_id,
            "createdAtMs": self.created_at_ms,
            "updatedAtMs": self.updated_at_ms,
        }
        if include_fills:
            payload["fills"] = [fill.to_payload() for fill in self.fills]
        return payload

    @property
    def average_entry_price(self) -> float | None:
        """说明：按成交量加权的平均入场价。"""
        entries = [fill for fill in self.fills if fill.kind is FillKind.ENTRY]
        if not entries:
            return None
        total_qty = sum(fill.quantity for fill in entries)
        if total_qty <= 0:
            return None
        weighted = sum(fill.price * fill.quantity for fill in entries)
        return weighted / total_qty

    @property
    def average_exit_price(self) -> float | None:
        """说明：按成交量加权的平均出场价，含 stop/target/exit。"""
        exits = [
            fill for fill in self.fills
            if fill.kind in (FillKind.EXIT, FillKind.STOP, FillKind.TARGET)
        ]
        if not exits:
            return None
        total_qty = sum(fill.quantity for fill in exits)
        if total_qty <= 0:
            return None
        weighted = sum(fill.price * fill.quantity for fill in exits)
        return weighted / total_qty
