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
    exchange_router: Any = None,
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

    def _optional_float(value: float | None) -> float | None:
        """把可选数值统一转换成 float，保持 None 语义。"""
        return None if value is None else float(value)

    def _target_prices(take_profit_price: float | None) -> tuple[float, ...]:
        return tuple() if take_profit_price is None else (float(take_profit_price),)

    def _exchange_router_required() -> str | None:
        if exchange_router is None:
            return "exchange router is not available in this agent runtime"
        return None

    def _infer_direction_from_positions(instrument_key: str) -> str | None:
        if exchange_router is None:
            return None
        positions = [
            position
            for position in exchange_router.get_positions(instrument_key)
            if getattr(position, "size", 0) > 0
        ]
        if len(positions) == 1:
            return str(positions[0].side)
        return None

    async def open_hyperliquid_testnet_trade(
        instrument_key: str,
        direction: str,
        size: float,
        reasoning: str,
        order_type: str = "market",
        limit_price: float | None = None,
        slippage: float = 0.05,
        take_profit_price: float | None = None,
        stop_loss_price: float | None = None,
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
        if take_profit_price is None or stop_loss_price is None:
            return _json_output({"error": "take_profit_price and stop_loss_price are required when opening a trade"})
        is_buy = direction_enum is TradeDirection.LONG
        try:
            result = open_hyperliquid_testnet_position(
                coin=coin,
                is_buy=is_buy,
                size=float(size),
                order_type=order_type_value,
                limit_price=None if limit_price is None else float(limit_price),
                slippage=float(slippage),
                take_profit_price=_optional_float(take_profit_price),
                stop_loss_price=_optional_float(stop_loss_price),
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
                stop_price=_optional_float(stop_loss_price),
                target_prices=_target_prices(take_profit_price),
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
            "开仓必须同时设置 take_profit_price 和 stop_loss_price。"
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
                "take_profit_price": {
                    "type": ["number", "null"],
                    "description": "可选止盈触发价；填写后会提交 reduce-only TP trigger 单",
                },
                "stop_loss_price": {
                    "type": ["number", "null"],
                    "description": "可选止损触发价；填写后会提交 reduce-only SL trigger 单",
                },
            },
            "required": [
                "instrument_key",
                "direction",
                "size",
                "reasoning",
                "take_profit_price",
                "stop_loss_price",
            ],
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
        take_profit_price: float | None = None,
        stop_loss_price: float | None = None,
    ) -> dict[str, Any]:
        """内部辅助：把交易所下单结果写入本地 TradeStore。"""
        status = TradeStatus.OPEN if result.filled_size else TradeStatus.PLANNED
        snapshot_id = _capture_snapshot(instrument_key)
        trade = store.create_trade(
            instrument_key=instrument_key,
            direction=direction_enum,
            size=float(size),
            intent_price=result.average_price,
            stop_price=_optional_float(stop_loss_price),
            target_prices=_target_prices(take_profit_price),
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
        take_profit_price: float | None = None,
        stop_loss_price: float | None = None,
    ) -> str:
        """在 Bitget 模拟盘提交开仓订单。"""
        if not instrument_key.startswith(("USDT-FUTURES:", "USDC-FUTURES:", "COIN-FUTURES:")):
            return _json_output({
                "error": "open_bitget_demo_trade only supports Bitget futures instruments"
            })
        try:
            direction_enum = TradeDirection(direction.lower())
        except ValueError:
            return _json_output({"error": f"invalid direction: {direction}"})
        if take_profit_price is None or stop_loss_price is None:
            return _json_output({"error": "take_profit_price and stop_loss_price are required when opening a trade"})
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
            preset_stop_surplus_price=_optional_float(take_profit_price),
            preset_stop_loss_price=_optional_float(stop_loss_price),
        )
        if not result.ok:
            return _json_output({"error": result.error})
        try:
            payload = _record_exchange_trade(
                instrument_key,
                direction_enum,
                size,
                reasoning,
                result,
                "bitget-demo-futures",
                take_profit_price=take_profit_price,
                stop_loss_price=stop_loss_price,
            )
            return _json_output(payload)
        except ValueError as exc:
            return _json_output({"error": str(exc), "order": result.raw})

    registry.register(ToolDefinition(
        name="open_bitget_demo_trade",
        description=(
            "在 Bitget 模拟盘提交开仓订单，并把结果写入本地交易记录。"
            "开仓必须同时设置 take_profit_price 和 stop_loss_price。"
            "只支持 USDT-FUTURES:*、USDC-FUTURES:* 或 COIN-FUTURES:* 标的。需要环境变量 "
            "BITGET_API_KEY, BITGET_API_SECRET, BITGET_API_PASSPHRASE。"
        ),
        parameters={
            "type": "object",
            "properties": {
                "instrument_key": {
                    "type": "string",
                    "description": "标的唯一标识，如 USDT-FUTURES:BTCUSDT 或 USDC-FUTURES:BTCPERP",
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
                "take_profit_price": {
                    "type": ["number", "null"],
                    "description": "可选止盈触发价；填写后通过 Bitget presetStopSurplusPrice 设置",
                },
                "stop_loss_price": {
                    "type": ["number", "null"],
                    "description": "可选止损触发价；填写后通过 Bitget presetStopLossPrice 设置",
                },
            },
            "required": [
                "instrument_key",
                "direction",
                "size",
                "reasoning",
                "take_profit_price",
                "stop_loss_price",
            ],
        },
        handler=open_bitget_demo_trade,
    ))

    async def get_exchange_positions(instrument_key: str | None = None) -> str:
        """查询交易所真实持仓和挂单，区别于本地 trade store 记录。"""
        error = _exchange_router_required()
        if error:
            return _json_output({"error": error})
        positions = exchange_router.get_positions(instrument_key)
        orders = exchange_router.get_orders(instrument_key)
        return _json_output({
            "positions": [position.to_payload() for position in positions],
            "orders": [order.to_payload() for order in orders],
        })

    registry.register(ToolDefinition(
        name="get_exchange_positions",
        description=(
            "查询交易所真实持仓和当前挂单，包括方向、数量、均价、未实现盈亏、强平价，以及可识别的 TP/SL trigger 单。"
            "涉及仓位管理、加仓、减仓、平仓、调整止盈止损前应先调用。"
        ),
        parameters={
            "type": "object",
            "properties": {
                "instrument_key": {
                    "type": ["string", "null"],
                    "description": "可选标的过滤；不传返回所有支持交易所的持仓和挂单",
                },
            },
        },
        handler=get_exchange_positions,
    ))

    async def modify_tpsl(
        instrument_key: str,
        direction: str | None = None,
        take_profit_price: float | None = None,
        stop_loss_price: float | None = None,
        size: float | None = None,
    ) -> str:
        """为已有交易所仓位设置新的止盈/止损条件单。"""
        error = _exchange_router_required()
        if error:
            return _json_output({"error": error})
        if take_profit_price is None and stop_loss_price is None:
            return _json_output({"error": "take_profit_price or stop_loss_price is required"})
        direction_value = direction or _infer_direction_from_positions(instrument_key)
        if direction_value is None:
            return _json_output({
                "error": "direction is required when it cannot be inferred from one matching exchange position"
            })
        try:
            direction_enum = TradeDirection(direction_value.lower())
        except ValueError:
            return _json_output({"error": f"invalid direction: {direction_value}"})

        results = exchange_router.place_tpsl(
            instrument_key=instrument_key,
            direction=direction_enum.value,
            take_profit_price=_optional_float(take_profit_price),
            stop_loss_price=_optional_float(stop_loss_price),
            size=_optional_float(size),
        )
        adjusted_trades: list[dict[str, Any]] = []
        for trade in store.list_trades(
            instrument_key=instrument_key,
            statuses=[TradeStatus.PLANNED, TradeStatus.OPEN],
        ):
            if trade.direction != direction_enum:
                continue
            adjusted = store.adjust_levels(
                trade.id,
                stop_price=_optional_float(stop_loss_price),
                target_prices=_target_prices(take_profit_price) if take_profit_price is not None else None,
            )
            adjusted_trades.append(adjusted.to_payload())
        return _json_output({
            "ok": all(result.ok for result in results),
            "orders": [result.to_payload() | {"raw": result.raw} for result in results],
            "adjustedLocalTrades": adjusted_trades,
        })

    registry.register(ToolDefinition(
        name="modify_tpsl",
        description=(
            "为已有交易所仓位设置或调整止盈止损。Bitget 使用 position TPSL；"
            "Hyperliquid 提交新的 reduce-only TP/SL trigger 单。调用前应先用 get_exchange_positions 确认仓位。"
        ),
        parameters={
            "type": "object",
            "properties": {
                "instrument_key": {"type": "string", "description": "标的唯一标识"},
                "direction": {
                    "type": ["string", "null"],
                    "enum": ["long", "short", None],
                    "description": "仓位方向；不传时仅在该标的只有一个真实仓位时自动推断",
                },
                "take_profit_price": {
                    "type": ["number", "null"],
                    "description": "新的止盈触发价；不需要调整止盈时留空",
                },
                "stop_loss_price": {
                    "type": ["number", "null"],
                    "description": "新的止损触发价；不需要调整止损时留空",
                },
                "size": {
                    "type": ["number", "null"],
                    "description": "Hyperliquid trigger 单数量；不传时尝试从真实仓位推断",
                },
            },
            "required": ["instrument_key"],
        },
        handler=modify_tpsl,
    ))

    async def close_position(
        instrument_key: str,
        direction: str | None = None,
        size: float | None = None,
        slippage: float = 0.05,
    ) -> str:
        """市价平掉交易所真实仓位。"""
        error = _exchange_router_required()
        if error:
            return _json_output({"error": error})
        direction_value = direction or _infer_direction_from_positions(instrument_key)
        if instrument_key.startswith(("USDT-FUTURES:", "USDC-FUTURES:", "COIN-FUTURES:")) and direction_value is None:
            return _json_output({
                "error": "direction is required for Bitget close_position when it cannot be inferred"
            })
        if direction_value is not None:
            try:
                direction_value = TradeDirection(direction_value.lower()).value
            except ValueError:
                return _json_output({"error": f"invalid direction: {direction_value}"})
        result = exchange_router.close_position(
            instrument_key=instrument_key,
            size=_optional_float(size),
            hold_side=direction_value,
            slippage=float(slippage),
        )
        return _json_output({
            "ok": result.ok,
            "order": result.to_payload() | {"raw": result.raw},
            "localOpenTrades": [
                trade.to_payload()
                for trade in store.list_trades(
                    instrument_key=instrument_key,
                    statuses=[TradeStatus.PLANNED, TradeStatus.OPEN],
                )
            ],
        })

    registry.register(ToolDefinition(
        name="close_position",
        description=(
            "市价平掉交易所真实仓位。Hyperliquid 可传 size 部分平仓，不传则全平该 coin；"
            "Bitget 使用 flash close，按 direction/holdSide 平指定方向。调用前应先用 get_exchange_positions 确认仓位。"
        ),
        parameters={
            "type": "object",
            "properties": {
                "instrument_key": {"type": "string", "description": "标的唯一标识"},
                "direction": {
                    "type": ["string", "null"],
                    "enum": ["long", "short", None],
                    "description": "要平的仓位方向；可在只有一个真实仓位时自动推断",
                },
                "size": {
                    "type": ["number", "null"],
                    "description": "可选平仓数量；Hyperliquid 支持部分平仓，Bitget flash close 会忽略该字段",
                },
                "slippage": {
                    "type": "number",
                    "description": "Hyperliquid market_close 滑点，默认 0.05 即 5%",
                    "default": 0.05,
                },
            },
            "required": ["instrument_key"],
        },
        handler=close_position,
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
