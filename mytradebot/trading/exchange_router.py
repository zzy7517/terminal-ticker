"""文件用途：交易所路由层，根据 instrument_key 前缀分发到对应客户端。"""
from __future__ import annotations

import logging
from typing import Any

from . import bitget as bitget_trading
from . import hyperliquid as hl_trading
from .exchange_models import ExchangeOrder, ExchangePosition, OrderResult, TradeSyncResult
from .models import FillKind, Trade, TradeStatus
from .store import TradeStore

_log = logging.getLogger(__name__)

EXCHANGE_HYPERLIQUID = "hyperliquid-testnet"
EXCHANGE_BITGET = "bitget-demo"
BITGET_FUTURES_PREFIXES = ("USDT-FUTURES:", "USDC-FUTURES:", "COIN-FUTURES:")


def _has_entry_fill(trade: Trade) -> bool:
    return any(fill.kind is FillKind.ENTRY and fill.quantity > 0 for fill in trade.fills)


class ExchangeRouter:
    """说明：聚合多交易所的持仓、订单和下单操作。"""

    def __init__(self, *, trade_store: TradeStore | None = None) -> None:
        self._trade_store = trade_store

    def get_all_positions(self) -> list[ExchangePosition]:
        positions: list[ExchangePosition] = []
        for fetcher, label in [
            (hl_trading.get_positions, "hyperliquid"),
            (bitget_trading.get_positions, "bitget"),
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
        ]:
            try:
                orders.extend(fetcher())
            except Exception:
                _log.warning("Failed to fetch %s orders", label, exc_info=True)
        return orders

    def get_positions(self, instrument_key: str | None = None) -> list[ExchangePosition]:
        positions = self.get_all_positions()
        if instrument_key is None:
            return positions
        return [position for position in positions if position.instrument_key == instrument_key]

    def get_orders(self, instrument_key: str | None = None) -> list[ExchangeOrder]:
        orders = self.get_all_orders()
        if instrument_key is None:
            return orders
        return [order for order in orders if order.instrument_key == instrument_key]

    def get_trade_fills_from_exchange(
        self,
        trade: Trade,
        *,
        limit: int = 50,
    ) -> list[dict[str, Any]]:
        exchange = self._exchange_for_key(trade.instrument_key)
        if exchange == EXCHANGE_HYPERLIQUID:
            coin = trade.instrument_key.split(":", 1)[1] if ":" in trade.instrument_key else ""
            start_ms = trade.opened_at_ms or trade.created_at_ms
            return hl_trading.get_user_fills(coin=coin, start_time_ms=start_ms, limit=limit)
        if exchange == EXCHANGE_BITGET:
            product_type, symbol = self._split_bitget_key(trade.instrument_key)
            return bitget_trading.get_order_fills(
                symbol=symbol,
                product_type=product_type,
                order_id=trade.external_order_id,
                limit=limit,
            )
        return []

    def sync_trade_status(self, trade: Trade) -> TradeSyncResult:
        """说明：用交易所实时持仓/挂单判断本地 OPEN trade 是否已经结束。"""
        exchange = self._exchange_for_key(trade.instrument_key)
        if trade.status is not TradeStatus.OPEN:
            return TradeSyncResult(
                exchange=exchange,
                status=trade.status.value,
                reason="local trade is not open",
            )
        if exchange == EXCHANGE_HYPERLIQUID and not hl_trading.hyperliquid_credentials_available():
            return TradeSyncResult(
                exchange=exchange,
                status="unknown",
                error="hyperliquid credentials are not configured",
            )
        if exchange == EXCHANGE_BITGET and not bitget_trading.bitget_credentials_available():
            return TradeSyncResult(
                exchange=exchange,
                status="unknown",
                error="bitget credentials are not configured",
            )
        if exchange == "unknown":
            return TradeSyncResult(
                exchange=exchange,
                status="unknown",
                error=f"unsupported exchange for {trade.instrument_key}",
            )

        try:
            positions = self.get_positions(trade.instrument_key)
            orders = self.get_orders(trade.instrument_key)
        except Exception as exc:
            return TradeSyncResult(
                exchange=exchange,
                status="unknown",
                error=str(exc) or exc.__class__.__name__,
            )

        matching_position = next(
            (
                position
                for position in positions
                if position.side == trade.direction.value and position.size > 0
            ),
            None,
        )
        active_orders = tuple(
            order
            for order in orders
            if order.reduce_only is not True
            and (
                not trade.external_order_id
                or order.order_id == trade.external_order_id
                or order.instrument_key == trade.instrument_key
            )
        )
        if matching_position is not None:
            return TradeSyncResult(
                exchange=exchange,
                status="open",
                position=matching_position,
                active_orders=active_orders,
                reason="matching exchange position is still open",
            )
        if active_orders and not _has_entry_fill(trade):
            return TradeSyncResult(
                exchange=exchange,
                status="open",
                active_orders=active_orders,
                reason="opening order is still active",
            )
        if not _has_entry_fill(trade):
            return TradeSyncResult(
                exchange=exchange,
                status="unknown",
                active_orders=active_orders,
                error="local trade has no entry fill; cannot infer closure safely",
            )
        return TradeSyncResult(
            exchange=exchange,
            status="closed",
            closed=True,
            active_orders=active_orders,
            reason="no matching exchange position remains",
        )

    def place_order(self, *, instrument_key: str, **kwargs: Any) -> OrderResult:
        exchange = self._exchange_for_key(instrument_key)
        if exchange == EXCHANGE_HYPERLIQUID:
            return self._place_hyperliquid(instrument_key, **kwargs)
        if exchange == EXCHANGE_BITGET:
            return self._place_bitget(instrument_key, **kwargs)
        return OrderResult(exchange="unknown", error=f"No trading support for {instrument_key}")

    def place_tpsl(
        self,
        *,
        instrument_key: str,
        direction: str,
        take_profit_price: float | None = None,
        stop_loss_price: float | None = None,
        size: float | None = None,
    ) -> list[OrderResult]:
        exchange = self._exchange_for_key(instrument_key)
        if exchange == EXCHANGE_HYPERLIQUID:
            return self._place_hyperliquid_tpsl(
                instrument_key,
                direction=direction,
                take_profit_price=take_profit_price,
                stop_loss_price=stop_loss_price,
                size=size,
            )
        if exchange == EXCHANGE_BITGET:
            return self._place_bitget_tpsl(
                instrument_key,
                direction=direction,
                take_profit_price=take_profit_price,
                stop_loss_price=stop_loss_price,
            )
        return [OrderResult(exchange="unknown", error=f"No TPSL support for {instrument_key}")]

    def close_position(
        self,
        *,
        instrument_key: str,
        size: float | None = None,
        hold_side: str | None = None,
        slippage: float = 0.05,
    ) -> OrderResult:
        exchange = self._exchange_for_key(instrument_key)
        if exchange == EXCHANGE_HYPERLIQUID:
            coin = instrument_key.split(":", 1)[1]
            try:
                result = hl_trading.close_position(
                    coin=coin,
                    size=size,
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
        if exchange == EXCHANGE_BITGET:
            product_type, symbol = self._split_bitget_key(instrument_key)
            return bitget_trading.close_position(
                symbol=symbol,
                product_type=product_type,
                hold_side=hold_side,
            )
        return OrderResult(exchange="unknown", error=f"No close support for {instrument_key}")

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
        return False

    @staticmethod
    def _exchange_for_key(instrument_key: str) -> str:
        if instrument_key.startswith("hyperliquid-testnet:"):
            return EXCHANGE_HYPERLIQUID
        if instrument_key.startswith(BITGET_FUTURES_PREFIXES):
            return EXCHANGE_BITGET
        return "unknown"

    @staticmethod
    def _split_bitget_key(instrument_key: str) -> tuple[str, str]:
        parts = instrument_key.split(":", 1)
        product_type = parts[0] if len(parts) == 2 else "USDT-FUTURES"
        symbol = parts[1] if len(parts) == 2 else instrument_key
        return product_type, symbol

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
                take_profit_price=(
                    float(kwargs["take_profit_price"])
                    if kwargs.get("take_profit_price") is not None
                    else None
                ),
                stop_loss_price=(
                    float(kwargs["stop_loss_price"])
                    if kwargs.get("stop_loss_price") is not None
                    else None
                ),
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

    @classmethod
    def _place_bitget(cls, instrument_key: str, **kwargs: Any) -> OrderResult:
        product_type, symbol = cls._split_bitget_key(instrument_key)
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
            preset_stop_surplus_price=(
                float(kwargs["take_profit_price"])
                if kwargs.get("take_profit_price") is not None
                else None
            ),
            preset_stop_loss_price=(
                float(kwargs["stop_loss_price"])
                if kwargs.get("stop_loss_price") is not None
                else None
            ),
        )

    def _infer_position_size(self, instrument_key: str, direction: str) -> float | None:
        for position in self.get_positions(instrument_key):
            if position.side == direction:
                return position.size
        return None

    def _place_hyperliquid_tpsl(
        self,
        instrument_key: str,
        *,
        direction: str,
        take_profit_price: float | None,
        stop_loss_price: float | None,
        size: float | None,
    ) -> list[OrderResult]:
        coin = instrument_key.split(":", 1)[1]
        order_size = size or self._infer_position_size(instrument_key, direction)
        if order_size is None:
            return [OrderResult(
                exchange=EXCHANGE_HYPERLIQUID,
                error="size is required when no matching exchange position is available",
            )]
        close_is_buy = direction == "short"
        results: list[OrderResult] = []
        for label, price in (("tp", take_profit_price), ("sl", stop_loss_price)):
            if price is None:
                continue
            try:
                result = hl_trading.place_trigger_order(
                    coin=coin,
                    is_buy=close_is_buy,
                    size=float(order_size),
                    trigger_price=float(price),
                    tpsl=label,
                )
                results.append(OrderResult(
                    exchange=EXCHANGE_HYPERLIQUID,
                    order_id=result.external_order_id,
                    average_price=result.average_price,
                    filled_size=result.filled_size,
                    resting=result.resting,
                    raw=result.raw,
                ))
            except hl_trading.HyperliquidTradingError as exc:
                results.append(OrderResult(exchange=EXCHANGE_HYPERLIQUID, error=str(exc)))
        return results

    @classmethod
    def _place_bitget_tpsl(
        cls,
        instrument_key: str,
        *,
        direction: str,
        take_profit_price: float | None,
        stop_loss_price: float | None,
    ) -> list[OrderResult]:
        product_type, symbol = cls._split_bitget_key(instrument_key)
        results: list[OrderResult] = []
        if take_profit_price is not None:
            results.append(bitget_trading.place_tpsl_order(
                symbol=symbol,
                product_type=product_type,
                plan_type="pos_profit",
                trigger_price=float(take_profit_price),
                hold_side=direction,
            ))
        if stop_loss_price is not None:
            results.append(bitget_trading.place_tpsl_order(
                symbol=symbol,
                product_type=product_type,
                plan_type="pos_loss",
                trigger_price=float(stop_loss_price),
                hold_side=direction,
            ))
        return results
