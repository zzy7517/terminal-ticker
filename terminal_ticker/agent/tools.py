"""Tool 系统：注册表、schema 生成和内置行情工具。"""
from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable

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

    async def get_candles(instrument_key: str, count: int = 20) -> str:
        """获取指定标的的最近 K 线数据。"""
        quote = context_provider.get_quote(instrument_key)
        if quote is None:
            return _json_output({"error": f"No candle data for {instrument_key}"})
        candles = quote.candles[-min(count, 50):]
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
        description="获取指定标的最近的 OHLCV K 线数据，可指定返回数量（最多 50 根）。",
        parameters={
            "type": "object",
            "properties": {
                "instrument_key": {
                    "type": "string",
                    "description": "标的唯一标识",
                },
                "count": {
                    "type": "integer",
                    "description": "返回 K 线数量，默认 20，最多 50",
                    "default": 20,
                },
            },
            "required": ["instrument_key"],
        },
        handler=get_candles,
    ))

    async def get_strategy_signal(instrument_key: str) -> str:
        """获取指定标的当前的本地策略信号。"""
        signal = context_provider.get_strategy_signal(instrument_key)
        if signal is None:
            return _json_output({"error": f"No strategy signal for {instrument_key}"})
        return _json_output(signal)

    registry.register(ToolDefinition(
        name="get_strategy_signal",
        description="获取指定标的的本地 regime/trend 策略分析信号，包括方向、regime、置信度和特征值。",
        parameters={
            "type": "object",
            "properties": {
                "instrument_key": {
                    "type": "string",
                    "description": "标的唯一标识",
                },
            },
            "required": ["instrument_key"],
        },
        handler=get_strategy_signal,
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
