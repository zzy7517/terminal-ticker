"""Tool 系统：注册表、schema 生成和内置行情工具。"""
from __future__ import annotations

import json
from dataclasses import dataclass
from inspect import isawaitable
from typing import Any, Awaitable, Callable

from ..trading import (
    BITGET_DEMO_FILL_SOURCE,
    FillKind,
    HYPERLIQUID_FILL_SOURCE,
    BitgetDemoTradingError,
    HyperliquidTradingError,
    TradeDirection,
    TradeStatus,
    TradeStore,
    open_bitget_demo_position,
    open_testnet_position as open_hyperliquid_testnet_position,
)
from ..trading import bitget as bitget_trading
from ..trading import alpaca as alpaca_trading
from ..trading.exchange_models import OrderResult
from ..config import BITGET_SOURCE, HYPERLIQUID_TESTNET_SOURCE

ToolHandler = Callable[..., Awaitable[str]]


@dataclass(frozen=True)
class ToolDefinition:
    """一个可被 LLM 调用的工具定义。"""

    name: str
    description: str
    parameters: dict[str, Any]
    handler: ToolHandler


@dataclass
class ToolCall:
    """模型返回的一次工具调用。"""

    id: str
    name: str
    arguments: dict[str, Any]


@dataclass
class ToolResult:
    """工具执行结果。"""

    call_id: str
    name: str
    output: str
    error: bool = False


BeforeToolHook = Callable[[ToolCall, ToolDefinition], ToolCall | None | Awaitable[ToolCall | None]]
AfterToolHook = Callable[
    [ToolCall, ToolResult, ToolDefinition],
    ToolResult | None | Awaitable[ToolResult | None],
]


class ToolRegistry:
    """管理所有可用工具的注册表。"""

    def __init__(
        self,
        *,
        before_tool_hooks: tuple[BeforeToolHook, ...] = tuple(),
        after_tool_hooks: tuple[AfterToolHook, ...] = tuple(),
    ) -> None:
        self._tools: dict[str, ToolDefinition] = {}
        self._before_tool_hooks = before_tool_hooks
        self._after_tool_hooks = after_tool_hooks

    def extend_hooks(
        self,
        *,
        before_tool_hooks: tuple[BeforeToolHook, ...] = tuple(),
        after_tool_hooks: tuple[AfterToolHook, ...] = tuple(),
    ) -> None:
        """追加 runtime 级工具钩子，用于审计、权限或参数改写。"""
        self._before_tool_hooks = (*self._before_tool_hooks, *before_tool_hooks)
        self._after_tool_hooks = (*self._after_tool_hooks, *after_tool_hooks)

    def register(self, tool: ToolDefinition) -> None:
        self._tools[tool.name] = tool

    def get(self, name: str) -> ToolDefinition | None:
        return self._tools.get(name)

    def list_tools(self) -> list[ToolDefinition]:
        return list(self._tools.values())

    def openai_tool_schemas(self) -> list[dict[str, Any]]:
        """生成 OpenAI function calling 格式的 tool schema 列表。"""
        schemas: list[dict[str, Any]] = []
        for tool in self._tools.values():
            schemas.append({
                "type": "function",
                "function": {
                    "name": tool.name,
                    "description": tool.description,
                    "parameters": tool.parameters,
                },
            })
        return schemas

    def codex_tool_schemas(self) -> list[dict[str, Any]]:
        """生成 Codex Responses API 格式的 tool schema 列表。"""
        schemas: list[dict[str, Any]] = []
        for tool in self._tools.values():
            schemas.append({
                "type": "function",
                "name": tool.name,
                "description": tool.description,
                "parameters": tool.parameters,
            })
        return schemas

    async def execute(self, call: ToolCall) -> ToolResult:
        """执行一次工具调用并返回结果。"""
        tool = self._tools.get(call.name)
        if tool is None:
            return ToolResult(
                call_id=call.id,
                name=call.name,
                output=f"Unknown tool: {call.name}",
                error=True,
            )
        effective_call = call
        try:
            for hook in self._before_tool_hooks:
                replacement = await _maybe_await(hook(effective_call, tool))
                if isinstance(replacement, ToolCall):
                    effective_call = replacement
            output = await tool.handler(**effective_call.arguments)
            result = ToolResult(call_id=effective_call.id, name=effective_call.name, output=output)
        except Exception as exc:
            result = ToolResult(
                call_id=effective_call.id,
                name=effective_call.name,
                output=str(exc) or exc.__class__.__name__,
                error=True,
            )
        for hook in self._after_tool_hooks:
            replacement = await _maybe_await(hook(effective_call, result, tool))
            if isinstance(replacement, ToolResult):
                result = replacement
        return result


def _json_output(data: Any) -> str:
    return json.dumps(data, ensure_ascii=False, separators=(",", ":"))


async def _maybe_await(value: Any) -> Any:
    if isawaitable(value):
        return await value
    return value


def _parse_bitget_instrument_key(instrument_key: str) -> tuple[str, str]:
    """说明：兼容当前 Bitget key 和旧文档里的 source 前缀写法。"""
    parts = [part.strip() for part in instrument_key.split(":") if part.strip()]
    if len(parts) == 2 and parts[0].upper() in {"SPOT", "USDT-FUTURES"}:
        return parts[1].upper(), parts[0].upper()
    if len(parts) == 3 and parts[0].lower() == BITGET_SOURCE:
        return parts[1].upper(), parts[2].upper()
    raise ValueError(
        "bitget instrument_key must look like USDT-FUTURES:BTCUSDT or bitget:BTCUSDT:USDT-FUTURES"
    )


def build_market_tools(context_provider: Any) -> ToolRegistry:
    """构建内置行情工具集。context_provider 提供行情数据访问。"""
    registry = ToolRegistry()

    async def get_quote(instrument_key: str) -> str:
        """获取指定标的的最新报价快照。"""
        quote = context_provider.get_quote(instrument_key)
        if quote is None:
            return _json_output({"error": f"No quote available for {instrument_key}"})
        return _json_output({
            "symbol": quote.symbol,
            "price": quote.price,
            "change": quote.change,
            "changePercent": quote.change_percent,
            "dayHigh": quote.day_high,
            "dayLow": quote.day_low,
            "volume": quote.volume,
            "status": quote.status,
        })

    registry.register(ToolDefinition(
        name="get_quote",
        description="获取指定标的的最新报价，包括价格、涨跌幅、成交量等。",
        parameters={
            "type": "object",
            "properties": {
                "instrument_key": {
                    "type": "string",
                    "description": "标的唯一标识，优先使用 list_instruments 返回的 key，如 USDT-FUTURES:BTCUSDT 或 alpaca:AAPL",
                },
            },
            "required": ["instrument_key"],
        },
        handler=get_quote,
    ))

    async def get_candles(
        instrument_key: str,
        count: int = 20,
        interval: str | None = None,
    ) -> str:
        """获取指定标的的最近 K 线数据。"""
        candles = context_provider.get_candles(instrument_key, interval=interval)
        if not candles:
            target = f"{instrument_key} @ {interval}" if interval else instrument_key
            return _json_output({"error": f"No candle data for {target}"})
        candle_count = max(1, min(int(count), 50))
        candles = candles[-candle_count:]
        return _json_output([{
            "time": c.open_time_ms // 1000,
            "open": c.open,
            "high": c.high,
            "low": c.low,
            "close": c.close,
            "volume": c.volume,
        } for c in candles])

    registry.register(ToolDefinition(
        name="get_candles",
        description="获取指定标的最近的 OHLCV K 线数据，可指定时间周期和返回数量（最多 50 根）。",
        parameters={
            "type": "object",
            "properties": {
                "instrument_key": {
                    "type": "string",
                    "description": "标的唯一标识",
                },
                "interval": {
                    "type": "string",
                    "description": "可选时间周期，例如 5m、15m、1H、4H、1D；不传时使用当前主周期",
                },
                "count": {
                    "type": "integer",
                    "description": "返回 K 线数量，默认 20，范围 1-50",
                    "default": 20,
                    "minimum": 1,
                    "maximum": 50,
                },
            },
            "required": ["instrument_key"],
        },
        handler=get_candles,
    ))

    async def list_instruments() -> str:
        """列出当前 watchlist 中的所有标的。"""
        instruments = context_provider.list_instruments()
        return _json_output([{
            "key": inst.key,
            "symbol": inst.symbol,
            "label": inst.label,
            "source": inst.source,
            "group": inst.group,
        } for inst in instruments])

    registry.register(ToolDefinition(
        name="list_instruments",
        description="列出当前 watchlist 中所有激活的标的及其基本信息。",
        parameters={
            "type": "object",
            "properties": {},
        },
        handler=list_instruments,
    ))

    return registry


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
        if session_id_provider is None:
            return None
        try:
            return session_id_provider()
        except Exception:
            return None

    def _capture_snapshot(instrument_key: str) -> int | None:
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

    async def open_alpaca_paper_trade(
        instrument_key: str,
        direction: str,
        size: float,
        reasoning: str,
        order_type: str = "market",
        limit_price: float | None = None,
        time_in_force: str = "day",
    ) -> str:
        """在 Alpaca paper trading 提交订单。"""
        if not instrument_key.startswith("alpaca:"):
            return _json_output({"error": "open_alpaca_paper_trade only supports alpaca:* instruments"})
        try:
            direction_enum = TradeDirection(direction.lower())
        except ValueError:
            return _json_output({"error": f"invalid direction: {direction}"})
        symbol = instrument_key.split(":", 1)[1]
        side = "buy" if direction_enum is TradeDirection.LONG else "sell"
        result = alpaca_trading.place_order(
            symbol=symbol,
            side=side,
            order_type=(order_type or "market").lower(),
            qty=float(size),
            limit_price=None if limit_price is None else float(limit_price),
            time_in_force=time_in_force,
        )
        if not result.ok:
            return _json_output({"error": result.error})
        try:
            payload = _record_exchange_trade(
                instrument_key, direction_enum, size, reasoning, result, "alpaca-paper",
            )
            return _json_output(payload)
        except ValueError as exc:
            return _json_output({"error": str(exc), "order": result.raw})

    registry.register(ToolDefinition(
        name="open_alpaca_paper_trade",
        description=(
            "在 Alpaca paper trading 提交订单，并把结果写入本地交易记录。"
            "只支持 alpaca:* 标的（美股/ETF）。需要环境变量 "
            "APCA_API_KEY_ID, APCA_API_SECRET_KEY。"
        ),
        parameters={
            "type": "object",
            "properties": {
                "instrument_key": {
                    "type": "string",
                    "description": "标的唯一标识，如 alpaca:AAPL",
                },
                "direction": {"type": "string", "enum": ["long", "short"]},
                "size": {"type": "number", "description": "股数，必须 > 0"},
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
                "time_in_force": {
                    "type": "string",
                    "enum": ["day", "gtc", "ioc", "fok"],
                    "default": "day",
                    "description": "订单有效期",
                },
            },
            "required": ["instrument_key", "direction", "size", "reasoning"],
        },
        handler=open_alpaca_paper_trade,
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


def build_news_tools(news_service: Any) -> ToolRegistry:
    """构建新闻相关工具集。news_service 为 None 时工具提示功能未启用。"""
    registry = ToolRegistry()

    def _disabled_reply(action: str) -> str:
        return _json_output({
            "enabled": False,
            "error": f"news module disabled; cannot {action}",
        })

    def _item_payload(item: Any) -> dict[str, Any]:
        payload = item.to_payload()
        return {
            "url": payload.get("url"),
            "source": payload.get("source"),
            "title": payload.get("title"),
            "summary": payload.get("summary"),
            "publishedAt": payload.get("publishedAt"),
            "keywords": payload.get("keywords", []),
        }

    async def get_recent_news(limit: int = 10, since_minutes: int | None = 120) -> str:
        """返回最近的新闻条目。"""
        if news_service is None:
            return _disabled_reply("get recent news")
        resolved_limit = max(1, min(int(limit or 10), 50))
        items = news_service.recent(limit=resolved_limit)
        if since_minutes is not None and since_minutes > 0:
            import time as _time
            cutoff = int(_time.time() * 1000) - int(since_minutes) * 60_000
            items = [item for item in items if item.published_at_ms >= cutoff]
        return _json_output({
            "count": len(items),
            "items": [_item_payload(item) for item in items],
        })

    async def refresh_news() -> str:
        """触发一次同步刷新并返回摘要。"""
        if news_service is None:
            return _disabled_reply("refresh news")
        outcome = await news_service.refresh_now()
        return _json_output({
            "status": outcome.status,
            "inserted": outcome.inserted,
            "totalRecent": outcome.total_recent,
            "error": outcome.error,
        })

    registry.register(ToolDefinition(
        name="get_recent_news",
        description=(
            "读取本地缓存的路透最新新闻条目（按发布时间倒序）。"
            "可选限制返回条数和最近时间窗口（分钟）。"
        ),
        parameters={
            "type": "object",
            "properties": {
                "limit": {"type": "integer", "default": 10, "minimum": 1, "maximum": 50},
                "since_minutes": {"type": ["integer", "null"], "default": 120, "minimum": 1},
            },
        },
        handler=get_recent_news,
    ))

    registry.register(ToolDefinition(
        name="refresh_news",
        description=(
            "立即向路透拉取最新 sitemap 并写入本地缓存。"
            "返回本次新增条数以及总缓存条数。"
        ),
        parameters={
            "type": "object",
            "properties": {},
        },
        handler=refresh_news,
    ))

    return registry


def build_social_feed_tools(social_feed_service: Any) -> ToolRegistry:
    """构建社交流相关工具集。"""
    registry = ToolRegistry()

    def _disabled_reply(action: str) -> str:
        return _json_output({
            "enabled": False,
            "error": f"social feed module disabled; cannot {action}",
        })

    def _item_payload(item: Any) -> dict[str, Any]:
        payload = item.to_payload()
        return {
            "source": payload.get("source"),
            "externalId": payload.get("externalId"),
            "url": payload.get("url"),
            "author": payload.get("author"),
            "text": payload.get("text"),
            "createdAt": payload.get("createdAt"),
            "metrics": payload.get("metrics"),
            "urls": payload.get("urls", []),
            "isRepost": payload.get("isRepost"),
            "repostedBy": payload.get("repostedBy"),
        }

    async def refresh_x_following_feed(count: int = 20) -> str:
        """触发一次 X Following feed 拉取并写入本地缓存。"""
        if social_feed_service is None:
            return _disabled_reply("refresh X following feed")
        resolved_count = max(1, min(int(count or 20), 100))
        outcome = await social_feed_service.refresh_x_following(count=resolved_count)
        return _json_output({
            "status": outcome.status,
            "inserted": outcome.inserted,
            "totalRecent": outcome.total_recent,
            "error": outcome.error,
        })

    registry.register(ToolDefinition(
        name="refresh_x_following_feed",
        description=(
            "低频读取用户 X/Twitter Following 信息流并写入本地缓存。"
            "需要环境变量 TWITTER_AUTH_TOKEN 和 TWITTER_CT0。"
        ),
        parameters={
            "type": "object",
            "properties": {
                "count": {"type": "integer", "default": 20, "minimum": 1, "maximum": 100},
            },
        },
        handler=refresh_x_following_feed,
    ))

    async def get_recent_social_feed(
        limit: int = 20,
        since_minutes: int | None = 24 * 60,
        query: str | None = None,
    ) -> str:
        """读取本地缓存的社交流条目。"""
        if social_feed_service is None:
            return _disabled_reply("get recent social feed")
        import time as _time

        resolved_limit = max(1, min(int(limit or 20), 100))
        since_ms = None
        if since_minutes is not None and int(since_minutes) > 0:
            since_ms = int(_time.time() * 1000) - int(since_minutes) * 60_000
        items = social_feed_service.recent_items(
            limit=resolved_limit,
            since_ms=since_ms,
            query=query,
        )
        return _json_output({
            "count": len(items),
            "items": [_item_payload(item) for item in items],
        })

    registry.register(ToolDefinition(
        name="get_recent_social_feed",
        description=(
            "读取本地缓存的 X/Twitter Following 信息流，按发布时间倒序。"
            "可按最近分钟数和关键词过滤，用于交易信息流回顾。"
        ),
        parameters={
            "type": "object",
            "properties": {
                "limit": {"type": "integer", "default": 20, "minimum": 1, "maximum": 100},
                "since_minutes": {"type": ["integer", "null"], "default": 1440, "minimum": 1},
                "query": {"type": ["string", "null"], "description": "可选关键词过滤"},
            },
        },
        handler=get_recent_social_feed,
    ))

    return registry


def merge_registries(*registries: ToolRegistry) -> ToolRegistry:
    """合并多个工具注册表到一个新注册表。"""
    merged = ToolRegistry()
    for registry in registries:
        for tool in registry.list_tools():
            merged.register(tool)
    return merged
