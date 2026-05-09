"""文件用途：交易记录子系统，管理订单、成交和快照。"""
from __future__ import annotations

from .models import (
    Fill,
    FillKind,
    Snapshot,
    Trade,
    TradeDirection,
    TradeStatus,
)
from .store import TradeStore, default_trade_store_path
from .bitget_demo import (
    BITGET_DEMO_FILL_SOURCE,
    BitgetDemoOrderResult,
    BitgetDemoTradingError,
    bitget_demo_credentials_available,
    open_demo_position as open_bitget_demo_position,
)
from .hyperliquid import (
    HYPERLIQUID_FILL_SOURCE,
    HyperliquidTradingError,
    hyperliquid_credentials_available,
    open_testnet_position,
)
from .exchange_models import ExchangeOrder, ExchangePosition, OrderResult, TradeSyncResult
from .exchange_router import ExchangeRouter

__all__ = [
    "Fill",
    "FillKind",
    "Snapshot",
    "Trade",
    "TradeDirection",
    "TradeStatus",
    "TradeStore",
    "default_trade_store_path",
    "BITGET_DEMO_FILL_SOURCE",
    "BitgetDemoOrderResult",
    "BitgetDemoTradingError",
    "bitget_demo_credentials_available",
    "open_bitget_demo_position",
    "HYPERLIQUID_FILL_SOURCE",
    "HyperliquidTradingError",
    "hyperliquid_credentials_available",
    "open_testnet_position",
    "ExchangeOrder",
    "ExchangePosition",
    "OrderResult",
    "TradeSyncResult",
    "ExchangeRouter",
]
