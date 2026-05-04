"""Tool 系统：注册表、schema 生成和内置行情工具。"""
from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable

from ..trading import (
    TradeDirection,
    TradeStatus,
    TradeStore,
)

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


class ToolRegistry:
    """管理所有可用工具的注册表。"""

    def __init__(self) -> None:
        self._tools: dict[str, ToolDefinition] = {}

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
        try:
            output = await tool.handler(**call.arguments)
            return ToolResult(call_id=call.id, name=call.name, output=output)
        except Exception as exc:
            return ToolResult(
                call_id=call.id,
                name=call.name,
                output=str(exc) or exc.__class__.__name__,
                error=True,
            )


def _json_output(data: Any) -> str:
    return json.dumps(data, ensure_ascii=False, separators=(",", ":"))


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
                    "description": "标的唯一标识，如 bitget:BTCUSDT:USDT-FUTURES 或 alpaca:AAPL",
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
    """构建 paper trading 工具集。

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

    async def open_paper_trade(
        instrument_key: str,
        direction: str,
        size: float,
        reasoning: str,
        entry_type: str = "market",
        entry_price: float | None = None,
        stop_price: float | None = None,
        target_prices: list[float] | None = None,
        market_kind: str = "",
    ) -> str:
        """开一笔虚拟订单。限价单撮合由 paper broker 在后续 1m K 线上处理。"""
        try:
            direction_enum = TradeDirection(direction.lower())
        except ValueError:
            return _json_output({"error": f"invalid direction: {direction}"})
        entry_type_value = (entry_type or "market").lower()
        if entry_type_value not in {"market", "limit"}:
            return _json_output({"error": f"invalid entry_type: {entry_type}"})
        resolved_entry_price: float | None
        if entry_type_value == "limit":
            if entry_price is None:
                return _json_output({"error": "limit order requires entry_price"})
            resolved_entry_price = float(entry_price)
            initial_status = TradeStatus.PLANNED
        else:
            resolved_entry_price = None
            initial_status = TradeStatus.PLANNED  # broker 会在下一根 1m K 线以 open 价 fill
        try:
            snapshot_id = _capture_snapshot(instrument_key)
            trade = store.create_trade(
                instrument_key=instrument_key,
                direction=direction_enum,
                size=float(size),
                intent_price=resolved_entry_price,
                stop_price=None if stop_price is None else float(stop_price),
                target_prices=tuple(float(p) for p in (target_prices or ())),
                reasoning_text=reasoning,
                session_id=_resolve_session_id(),
                snapshot_id=snapshot_id,
                market_kind=market_kind,
                status=initial_status,
            )
        except ValueError as exc:
            return _json_output({"error": str(exc)})
        return _json_output({"ok": True, "trade": trade.to_payload()})

    registry.register(ToolDefinition(
        name="open_paper_trade",
        description=(
            "开一笔虚拟订单并冻结当下多周期上下文。market 单会在下一根 1m K 线以 open 价 fill；"
            "limit 单会在价格触及 entry_price 时 fill。stop/target 由 broker 自动撮合。"
            "所有订单只是 paper trading，不会真实下单。"
        ),
        parameters={
            "type": "object",
            "properties": {
                "instrument_key": {"type": "string", "description": "标的唯一标识"},
                "direction": {"type": "string", "enum": ["long", "short"]},
                "size": {"type": "number", "description": "订单数量，必须 > 0"},
                "reasoning": {
                    "type": "string",
                    "description": "开单理由，会写入 trade 记录用于后续复盘",
                },
                "entry_type": {
                    "type": "string",
                    "enum": ["market", "limit"],
                    "default": "market",
                },
                "entry_price": {
                    "type": ["number", "null"],
                    "description": "限价单必填；市价单留空",
                },
                "stop_price": {"type": ["number", "null"]},
                "target_prices": {
                    "type": "array",
                    "items": {"type": "number"},
                    "description": "一个或多个止盈价位",
                },
                "market_kind": {
                    "type": "string",
                    "description": "可选，记录市场类型标签，如 crypto / equity / index",
                },
            },
            "required": ["instrument_key", "direction", "size", "reasoning"],
        },
        handler=open_paper_trade,
    ))

    async def list_open_trades(instrument_key: str | None = None) -> str:
        """列出 planned 或 open 状态的虚拟订单。"""
        trades = store.list_trades(
            instrument_key=instrument_key,
            statuses=[TradeStatus.PLANNED, TradeStatus.OPEN],
        )
        return _json_output([t.to_payload() for t in trades])

    registry.register(ToolDefinition(
        name="list_open_trades",
        description="列出当前 planned 或 open 状态的虚拟订单；可选按标的过滤。",
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

    async def cancel_paper_trade(trade_id: int) -> str:
        """取消 planned 虚拟订单。已 open 的无法取消，请用 close_paper_trade。"""
        try:
            trade = store.cancel_trade(int(trade_id))
        except ValueError as exc:
            return _json_output({"error": str(exc)})
        return _json_output({"ok": True, "trade": trade.to_payload()})

    registry.register(ToolDefinition(
        name="cancel_paper_trade",
        description="取消一笔处于 planned 状态的虚拟订单。",
        parameters={
            "type": "object",
            "properties": {
                "trade_id": {"type": "integer"},
            },
            "required": ["trade_id"],
        },
        handler=cancel_paper_trade,
    ))

    async def adjust_paper_trade(
        trade_id: int,
        stop_price: float | None = None,
        target_prices: list[float] | None = None,
    ) -> str:
        """调整 planned 或 open 订单的止损和止盈价位。"""
        try:
            trade = store.adjust_levels(
                int(trade_id),
                stop_price=None if stop_price is None else float(stop_price),
                target_prices=(
                    None if target_prices is None
                    else [float(p) for p in target_prices]
                ),
            )
        except ValueError as exc:
            return _json_output({"error": str(exc)})
        return _json_output({"ok": True, "trade": trade.to_payload()})

    registry.register(ToolDefinition(
        name="adjust_paper_trade",
        description="调整虚拟订单的止损或止盈价位。传 null 表示不修改该字段。",
        parameters={
            "type": "object",
            "properties": {
                "trade_id": {"type": "integer"},
                "stop_price": {"type": ["number", "null"]},
                "target_prices": {
                    "type": ["array", "null"],
                    "items": {"type": "number"},
                },
            },
            "required": ["trade_id"],
        },
        handler=adjust_paper_trade,
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
            "读取已关闭和取消的虚拟订单历史，含每笔交易的 reasoning、实现盈亏和成交价位。"
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


def merge_registries(*registries: ToolRegistry) -> ToolRegistry:
    """合并多个工具注册表到一个新注册表。"""
    merged = ToolRegistry()
    for registry in registries:
        for tool in registry.list_tools():
            merged.register(tool)
    return merged
