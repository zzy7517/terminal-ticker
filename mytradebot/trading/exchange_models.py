"""文件用途：交易所统一数据模型，定义持仓、订单和下单结果。"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


@dataclass(frozen=True)
class ExchangePosition:
    """说明：交易所实时持仓。"""

    exchange: str
    symbol: str
    instrument_key: str
    side: str
    size: float
    entry_price: float
    mark_price: float
    unrealized_pnl: float
    leverage: float | None = None
    margin: float | None = None
    liquidation_price: float | None = None

    def to_payload(self) -> dict[str, Any]:
        return {
            "exchange": self.exchange,
            "symbol": self.symbol,
            "instrumentKey": self.instrument_key,
            "side": self.side,
            "size": self.size,
            "entryPrice": self.entry_price,
            "markPrice": self.mark_price,
            "unrealizedPnl": self.unrealized_pnl,
            "leverage": self.leverage,
            "margin": self.margin,
            "liquidationPrice": self.liquidation_price,
        }


@dataclass(frozen=True)
class ExchangeOrder:
    """说明：交易所挂单/活跃订单。"""

    exchange: str
    symbol: str
    instrument_key: str
    order_id: str
    side: str
    order_type: str
    size: float
    price: float | None
    filled_size: float
    status: str
    created_at_ms: int

    def to_payload(self) -> dict[str, Any]:
        return {
            "exchange": self.exchange,
            "symbol": self.symbol,
            "instrumentKey": self.instrument_key,
            "orderId": self.order_id,
            "side": self.side,
            "orderType": self.order_type,
            "size": self.size,
            "price": self.price,
            "filledSize": self.filled_size,
            "status": self.status,
            "createdAtMs": self.created_at_ms,
        }


@dataclass(frozen=True)
class OrderResult:
    """说明：下单结果。"""

    exchange: str
    order_id: str | None = None
    average_price: float | None = None
    filled_size: float | None = None
    resting: bool = False
    error: str | None = None
    raw: dict[str, Any] = field(default_factory=dict)

    @property
    def ok(self) -> bool:
        return self.error is None

    def to_payload(self) -> dict[str, Any]:
        return {
            "exchange": self.exchange,
            "orderId": self.order_id,
            "averagePrice": self.average_price,
            "filledSize": self.filled_size,
            "resting": self.resting,
            "error": self.error,
        }
