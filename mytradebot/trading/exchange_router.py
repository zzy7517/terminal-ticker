"""文件用途：交易所路由层，根据 instrument_key 前缀分发到对应客户端。"""
from __future__ import annotations

import logging
from typing import Any

from . import alpaca as alpaca_trading
from . import bitget as bitget_trading
from . import hyperliquid as hl_trading
from .exchange_models import ExchangeOrder, ExchangePosition, OrderResult
from .store import TradeStore

_log = logging.getLogger(__name__)

EXCHANGE_HYPERLIQUID = "hyperliquid-testnet"
EXCHANGE_BITGET = "bitget-demo"
EXCHANGE_ALPACA = "alpaca-paper"


class ExchangeRouter:
    """说明：聚合多交易所的持仓、订单和下单操作。"""

    def __init__(self, *, trade_store: TradeStore | None = None) -> None:
        self._trade_store = trade_store

    def get_all_positions(self) -> list[ExchangePosition]:
        positions: list[ExchangePosition] = []
        for fetcher, label in [
            (hl_trading.get_positions, "hyperliquid"),
            (bitget_trading.get_positions, "bitget"),
            (alpaca_trading.get_positions, "alpaca"),
        ]:
            try:
                positions.extend(fetcher())
            except Exception:
                _log.warning("Failed to fetch %s positions", label, exc_info=True)
        return positions

    def get_all_orders(self) -> list[ExchangeOrder]:
        orders: list[ExchangeOrder] = []
        for fetcher, label in [
            (hl_trading.get_open_orders, "hyperliquid"),
            (bitget_trading.get_open_orders, "bitget"),
            (alpaca_trading.get_open_orders, "alpaca"),
        ]:
            try:
                orders.extend(fetcher())
            except Exception:
                _log.warning("Failed to fetch %s orders", label, exc_info=True)
        return orders

    def place_order(self, *, instrument_key: str, **kwargs: Any) -> OrderResult:
        exchange = self._exchange_for_key(instrument_key)
        if exchange == EXCHANGE_HYPERLIQUID:
            return self._place_hyperliquid(instrument_key, **kwargs)
        if exchange == EXCHANGE_BITGET:
            return self._place_bitget(instrument_key, **kwargs)
        if exchange == EXCHANGE_ALPACA:
            return self._place_alpaca(instrument_key, **kwargs)
        return OrderResult(exchange="unknown", error=f"No trading support for {instrument_key}")

    def cancel_order(self, *, exchange: str, order_id: str, symbol: str = "", **kwargs: Any) -> bool:
        if exchange == EXCHANGE_HYPERLIQUID:
            coin = symbol or order_id
            return hl_trading.cancel_order(order_id=order_id, coin=coin)
        if exchange == EXCHANGE_BITGET:
            return bitget_trading.cancel_order(
                order_id=order_id,
                symbol=symbol,
                product_type=kwargs.get("product_type", "USDT-FUTURES"),
            )
        if exchange == EXCHANGE_ALPACA:
            return alpaca_trading.cancel_order(order_id=order_id)
        return False

    @staticmethod
    def _exchange_for_key(instrument_key: str) -> str:
        if instrument_key.startswith("hyperliquid-testnet:"):
            return EXCHANGE_HYPERLIQUID
        if instrument_key.startswith("USDT-FUTURES:") or instrument_key.startswith("SPOT:"):
            return EXCHANGE_BITGET
        if instrument_key.startswith("alpaca:"):
            return EXCHANGE_ALPACA
        return "unknown"

    @staticmethod
    def _place_hyperliquid(instrument_key: str, **kwargs: Any) -> OrderResult:
        coin = instrument_key.split(":", 1)[1]
        direction = kwargs.get("direction", "long")
        is_buy = direction == "long"
        size = float(kwargs.get("size", 0))
        order_type = kwargs.get("order_type", "market")
        limit_price = kwargs.get("limit_price")
        slippage = float(kwargs.get("slippage", 0.05))
        try:
            result = hl_trading.open_testnet_position(
                coin=coin,
                is_buy=is_buy,
                size=size,
                order_type=order_type,
                limit_price=float(limit_price) if limit_price is not None else None,
                slippage=slippage,
            )
            return OrderResult(
                exchange=EXCHANGE_HYPERLIQUID,
                order_id=result.external_order_id,
                average_price=result.average_price,
                filled_size=result.filled_size,
                resting=result.resting,
                raw=result.raw,
            )
        except hl_trading.HyperliquidTradingError as exc:
            return OrderResult(exchange=EXCHANGE_HYPERLIQUID, error=str(exc))

    @staticmethod
    def _place_bitget(instrument_key: str, **kwargs: Any) -> OrderResult:
        parts = instrument_key.split(":", 1)
        product_type = parts[0] if len(parts) == 2 else "USDT-FUTURES"
        symbol = parts[1] if len(parts) == 2 else instrument_key
        direction = kwargs.get("direction", "long")
        side = "buy" if direction == "long" else "sell"
        return bitget_trading.place_order(
            symbol=symbol,
            product_type=product_type,
            side=side,
            trade_side=kwargs.get("trade_side", "open"),
            order_type=kwargs.get("order_type", "market"),
            size=float(kwargs.get("size", 0)),
            price=float(kwargs["limit_price"]) if kwargs.get("limit_price") is not None else None,
        )

    @staticmethod
    def _place_alpaca(instrument_key: str, **kwargs: Any) -> OrderResult:
        symbol = instrument_key.split(":", 1)[1] if ":" in instrument_key else instrument_key
        direction = kwargs.get("direction", "long")
        side = "buy" if direction == "long" else "sell"
        return alpaca_trading.place_order(
            symbol=symbol,
            side=side,
            order_type=kwargs.get("order_type", "market"),
            qty=float(kwargs["size"]) if kwargs.get("size") is not None else None,
            notional=float(kwargs["notional"]) if kwargs.get("notional") is not None else None,
            limit_price=float(kwargs["limit_price"]) if kwargs.get("limit_price") is not None else None,
            time_in_force=kwargs.get("time_in_force", "day"),
        )
