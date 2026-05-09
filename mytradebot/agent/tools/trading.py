"""交易工具：Hyperliquid 测试网 / Bitget 模拟盘下单 + 交易历史查询。"""
from __future__ import annotations

from typing import Any, Callable

from ...trading import (
    FillKind,
    HYPERLIQUID_FILL_SOURCE,
    HyperliquidTradingError,
    TradeDirection,
    TradeStatus,
    TradeStore,
    open_testnet_position as open_hyperliquid_testnet_position,
)
from ...trading import bitget as bitget_trading
from ...trading.exchange_models import OrderResult
from ...config import HYPERLIQUID_TESTNET_SOURCE
from .registry import ToolDefinition, ToolRegistry, _json_output


def build_trading_tools(
    *,
    store: TradeStore,
    snapshot_provider: Callable[[str], dict[str, Any]] | None = None,
    session_id_provider: Callable[[], str | None] | None = None,
) -> ToolRegistry:
    """构建交易记录和 Hyperliquid 测试网工具集。

    snapshot_provider(instrument_key) 应返回当前多周期上下文字典，open 时冻结。
    session_id_provider() 返回当前 agent 会话 ID，用于串联 trade 与对话。
    """
    registry = ToolRegistry()

    def _resolve_session_id() -> str | None:
        """获取当前 agent 会话 ID，失败时返回 None。"""
        if session_id_provider is None:
            return None
        try:
            return session_id_provider()
        except Exception:
            return None

    def _capture_snapshot(instrument_key: str) -> int | None:
        """冻结指定标的的多周期上下文快照并返回快照 ID。"""
        if snapshot_provider is None:
            return None
        try:
            payload = snapshot_provider(instrument_key)
        except Exception:
            return None
        if not isinstance(payload, dict) or not payload:
            return None
        snap = store.save_snapshot(instrument_key=instrument_key, payload=payload)
        return snap.id

    async def open_hyperliquid_testnet_trade(
        instrument_key: str,
        direction: str,
        size: float,
        reasoning: str,
        order_type: str = "market",
        limit_price: float | None = None,
        slippage: float = 0.05,
    ) -> str:
        """在 Hyperliquid 测试网真实提交开仓订单，并同步记录到本地交易表。"""
        if not instrument_key.startswith(f"{HYPERLIQUID_TESTNET_SOURCE}:"):
            return _json_output({
                "error": (
                    "open_hyperliquid_testnet_trade only supports "
                    f"{HYPERLIQUID_TESTNET_SOURCE}:* instruments"
                )
            })
        coin = instrument_key.split(":", 1)[1]
        try:
            direction_enum = TradeDirection(direction.lower())
        except ValueError:
            return _json_output({"error": f"invalid direction: {direction}"})
        order_type_value = (order_type or "market").lower()
        if order_type_value not in {"market", "limit"}:
            return _json_output({"error": f"invalid order_type: {order_type}"})
        if order_type_value == "limit" and limit_price is None:
            return _json_output({"error": "limit order requires limit_price"})
        is_buy = direction_enum is TradeDirection.LONG
        try:
            result = open_hyperliquid_testnet_position(
                coin=coin,
                is_buy=is_buy,
                size=float(size),
                order_type=order_type_value,
                limit_price=None if limit_price is None else float(limit_price),
                slippage=float(slippage),
            )
        except (HyperliquidTradingError, ValueError) as exc:
            return _json_output({"error": str(exc)})

        status = TradeStatus.OPEN if result.filled_size else TradeStatus.PLANNED
        intent_price = result.average_price if result.average_price is not None else limit_price
        try:
            snapshot_id = _capture_snapshot(instrument_key)
            trade = store.create_trade(
                instrument_key=instrument_key,
                direction=direction_enum,
                size=float(size),
                intent_price=None if intent_price is None else float(intent_price),
                stop_price=None,
                target_prices=tuple(),
                reasoning_text=reasoning,
                session_id=_resolve_session_id(),
                snapshot_id=snapshot_id,
                market_kind="hyperliquid-testnet-perp",
                fill_source=HYPERLIQUID_FILL_SOURCE,
                status=status,
                external_order_id=result.external_order_id,
            )
            fill = None
            if result.filled_size and result.average_price is not None:
                fill = store.record_fill(
                    trade_id=trade.id,
                    kind=FillKind.ENTRY,
                    price=float(result.average_price),
                    quantity=float(result.filled_size),
                    trigger_reason="hyperliquid testnet order filled",
                    fill_source=HYPERLIQUID_FILL_SOURCE,
                    external_order_id=result.external_order_id,
                )
                trade = store.get_trade(trade.id) or trade
        except ValueError as exc:
            return _json_output({"error": str(exc), "order": result.raw})

        return _json_output({
            "ok": True,
            "testnet": True,
            "trade": trade.to_payload(),
            "fill": fill.to_payload() if fill is not None else None,
            "order": result.raw,
        })

    registry.register(ToolDefinition(
        name="open_hyperliquid_testnet_trade",
        description=(
            "在 Hyperliquid 测试网提交真实开仓订单，并把结果写入本地交易记录。"
            "只支持 hyperliquid-testnet:* 标的。需要环境变量 "
            "HYPERLIQUID_TESTNET_PRIVATE_KEY，可选 HYPERLIQUID_TESTNET_ACCOUNT_ADDRESS / "
            "HYPERLIQUID_TESTNET_VAULT_ADDRESS。market 单通过 SDK 以 IOC aggressive limit 实现。"
        ),
        parameters={
            "type": "object",
            "properties": {
                "instrument_key": {
                    "type": "string",
                    "description": "标的唯一标识，如 hyperliquid-testnet:BTC",
                },
                "direction": {"type": "string", "enum": ["long", "short"]},
                "size": {"type": "number", "description": "合约数量，必须 > 0"},
                "reasoning": {
                    "type": "string",
                    "description": "开仓理由，会写入本地 trade 记录",
                },
                "order_type": {
                    "type": "string",
                    "enum": ["market", "limit"],
                    "default": "market",
                },
                "limit_price": {
                    "type": ["number", "null"],
                    "description": "limit 单必填；market 单可留空",
                },
                "slippage": {
                    "type": "number",
                    "description": "market 单允许滑点，默认 0.05 即 5%",
                    "default": 0.05,
                },
            },
            "required": ["instrument_key", "direction", "size", "reasoning"],
        },
        handler=open_hyperliquid_testnet_trade,
    ))

    def _record_exchange_trade(
        instrument_key: str,
        direction_enum: TradeDirection,
        size: float,
        reasoning: str,
        result: OrderResult,
        market_kind: str,
    ) -> dict[str, Any]:
        """内部辅助：把交易所下单结果写入本地 TradeStore。"""
        status = TradeStatus.OPEN if result.filled_size else TradeStatus.PLANNED
        snapshot_id = _capture_snapshot(instrument_key)
        trade = store.create_trade(
            instrument_key=instrument_key,
            direction=direction_enum,
            size=float(size),
            intent_price=result.average_price,
            stop_price=None,
            target_prices=tuple(),
            reasoning_text=reasoning,
            session_id=_resolve_session_id(),
            snapshot_id=snapshot_id,
            market_kind=market_kind,
            fill_source=result.exchange,
            status=status,
            external_order_id=result.order_id,
        )
        fill = None
        if result.filled_size and result.average_price is not None:
            fill = store.record_fill(
                trade_id=trade.id,
                kind=FillKind.ENTRY,
                price=float(result.average_price),
                quantity=float(result.filled_size),
                trigger_reason=f"{result.exchange} order filled",
                fill_source=result.exchange,
                external_order_id=result.order_id,
            )
            trade = store.get_trade(trade.id) or trade
        return {
            "ok": True,
            "exchange": result.exchange,
            "trade": trade.to_payload(),
            "fill": fill.to_payload() if fill is not None else None,
            "order": result.raw,
        }

    async def open_bitget_demo_trade(
        instrument_key: str,
        direction: str,
        size: float,
        reasoning: str,
        order_type: str = "market",
        limit_price: float | None = None,
    ) -> str:
        """在 Bitget 模拟盘提交开仓订单。"""
        if not (instrument_key.startswith("USDT-FUTURES:") or instrument_key.startswith("SPOT:")):
            return _json_output({"error": "open_bitget_demo_trade only supports USDT-FUTURES:* or SPOT:* instruments"})
        try:
            direction_enum = TradeDirection(direction.lower())
        except ValueError:
            return _json_output({"error": f"invalid direction: {direction}"})
        parts = instrument_key.split(":", 1)
        product_type = parts[0]
        symbol = parts[1]
        side = "buy" if direction_enum is TradeDirection.LONG else "sell"
        result = bitget_trading.place_order(
            symbol=symbol,
            product_type=product_type,
            side=side,
            trade_side="open",
            order_type=(order_type or "market").lower(),
            size=float(size),
            price=None if limit_price is None else float(limit_price),
        )
        if not result.ok:
            return _json_output({"error": result.error})
        try:
            payload = _record_exchange_trade(
                instrument_key, direction_enum, size, reasoning, result, "bitget-demo-futures",
            )
            return _json_output(payload)
        except ValueError as exc:
            return _json_output({"error": str(exc), "order": result.raw})

    registry.register(ToolDefinition(
        name="open_bitget_demo_trade",
        description=(
            "在 Bitget 模拟盘提交开仓订单，并把结果写入本地交易记录。"
            "只支持 USDT-FUTURES:* 或 SPOT:* 标的。需要环境变量 "
            "BITGET_API_KEY, BITGET_API_SECRET, BITGET_API_PASSPHRASE。"
        ),
        parameters={
            "type": "object",
            "properties": {
                "instrument_key": {
                    "type": "string",
                    "description": "标的唯一标识，如 USDT-FUTURES:BTCUSDT 或 SPOT:ETHUSDT",
                },
                "direction": {"type": "string", "enum": ["long", "short"]},
                "size": {"type": "number", "description": "订单数量，必须 > 0"},
                "reasoning": {
                    "type": "string",
                    "description": "下单理由，会写入本地 trade 记录",
                },
                "order_type": {
                    "type": "string",
                    "enum": ["market", "limit"],
                    "default": "market",
                },
                "limit_price": {
                    "type": ["number", "null"],
                    "description": "limit 单必填；market 单可留空",
                },
            },
            "required": ["instrument_key", "direction", "size", "reasoning"],
        },
        handler=open_bitget_demo_trade,
    ))

    async def list_open_trades(instrument_key: str | None = None) -> str:
        """列出 planned 或 open 状态的本地交易记录。"""
        trades = store.list_trades(
            instrument_key=instrument_key,
            statuses=[TradeStatus.PLANNED, TradeStatus.OPEN],
        )
        return _json_output([t.to_payload() for t in trades])

    registry.register(ToolDefinition(
        name="list_open_trades",
        description="列出当前 planned 或 open 状态的本地交易记录；可选按标的过滤。",
        parameters={
            "type": "object",
            "properties": {
                "instrument_key": {
                    "type": ["string", "null"],
                    "description": "可选标的过滤",
                },
            },
        },
        handler=list_open_trades,
    ))

    async def get_trade_history(
        instrument_key: str | None = None,
        limit: int = 20,
    ) -> str:
        """读取已关闭交易和取消订单的历史。用于复盘和汲取教训。"""
        capped = max(1, min(int(limit), 100))
        trades = store.list_trades(
            instrument_key=instrument_key,
            statuses=[TradeStatus.CLOSED, TradeStatus.CANCELLED],
            limit=capped,
        )
        return _json_output([t.to_payload() for t in trades])

    registry.register(ToolDefinition(
        name="get_trade_history",
        description=(
            "读取已关闭和取消的本地交易历史，含每笔交易的 reasoning、实现盈亏和成交价位。"
            "用于复盘时汲取经验。"
        ),
        parameters={
            "type": "object",
            "properties": {
                "instrument_key": {"type": ["string", "null"]},
                "limit": {"type": "integer", "default": 20, "minimum": 1, "maximum": 100},
            },
        },
        handler=get_trade_history,
    ))

    return registry
