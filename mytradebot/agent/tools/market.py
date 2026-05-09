"""行情工具：get_quote / get_candles / list_instruments。"""
from __future__ import annotations

from typing import Any

from .registry import ToolDefinition, ToolRegistry, _json_output


def build_market_tools(
    context_provider: Any,
    *,
    candidate_instrument_keys: tuple[str, ...] = tuple(),
) -> ToolRegistry:
    """构建内置行情工具集。context_provider 提供行情数据访问。"""
    registry = ToolRegistry()
    candidate_keys = tuple(key for key in candidate_instrument_keys if key)
    candidate_set = set(candidate_keys)

    def _resolve_key(instrument_key: str) -> str:
        """通过 context_provider 解析标的键名，无解析器时原样返回。"""
        resolver = getattr(context_provider, "resolve_instrument_key", None)
        if callable(resolver):
            return str(resolver(instrument_key))
        return instrument_key

    def _candidate_error(instrument_key: str) -> str | None:
        """检查标的是否在候选范围内，超出则返回错误信息。"""
        if not candidate_set:
            return None
        resolved = _resolve_key(instrument_key)
        if resolved not in candidate_set:
            return f"{resolved} is outside this turn's candidateInstrumentKeys"
        return None

    async def get_quote(instrument_key: str) -> str:
        """获取指定标的的最新报价快照。"""
        candidate_error = _candidate_error(instrument_key)
        if candidate_error:
            return _json_output({"error": candidate_error})
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
        candidate_error = _candidate_error(instrument_key)
        if candidate_error:
            return _json_output({"error": candidate_error})
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
        if candidate_set:
            instruments = tuple(inst for inst in instruments if inst.key in candidate_set)
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
