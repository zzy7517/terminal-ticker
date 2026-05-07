"""文件用途：Agent 层，构造行情上下文并创建 LLM provider。"""
from __future__ import annotations

from typing import Any, Protocol

from ..config import AgentConfig
from ..domain.quotes import QuoteState
from ..domain.price_action import Candle
from ..market_data.router import MarketInstrument
from .loop import ChatResponse, StreamDeltaHandler


class LLMProviderUnavailable(RuntimeError):
    """说明：表示模型 provider 缺少凭证或运行环境不可用。"""


class LLMProviderError(RuntimeError):
    """说明：表示模型 provider 请求失败但配置本身可用。"""


class LLMProvider(Protocol):
    """说明：定义所有 transcript agent provider 必须实现的接口。"""

    name: str
    model: str

    async def chat(
        self,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]] | None = None,
        on_delta: StreamDeltaHandler | None = None,
    ) -> ChatResponse:
        """说明：执行一轮 transcript chat，可通过 on_delta 流式返回文本。"""


def _short_candle(candle: Candle) -> dict[str, Any]:
    """说明：把一根 K 线压缩成 Agent 输入。"""
    return {
        "time": candle.open_time_ms // 1000,
        "open": candle.open,
        "high": candle.high,
        "low": candle.low,
        "close": candle.close,
        "volume": candle.volume,
    }


def _serialized_timeframes(
    quote: QuoteState,
    *,
    primary_interval: str,
    max_candles: int,
) -> list[dict[str, Any]]:
    """说明：把多周期 K 线压缩成可直接传给 LLM 的时间框架列表。"""
    ordered: list[str] = []
    if primary_interval in quote.multi_timeframe_candles:
        ordered.append(primary_interval)
    for interval in quote.multi_timeframe_candles:
        if interval not in ordered:
            ordered.append(interval)
    timeframes: list[dict[str, Any]] = []
    for interval in ordered:
        candles = tuple(quote.multi_timeframe_candles.get(interval, tuple()))[-max_candles:]
        if not candles:
            continue
        timeframes.append({
            "interval": interval,
            "candles": [_short_candle(candle) for candle in candles],
        })
    return timeframes


def build_agent_context(
    *,
    instrument: MarketInstrument,
    quote: QuoteState,
    interval: str,
    max_candles: int,
    session_history: tuple[dict[str, Any], ...] = tuple(),
) -> dict[str, Any]:
    """说明：构造发送给 LLM provider 的结构化行情上下文。"""
    candles = tuple(quote.candles[-max_candles:])
    timeframes = _serialized_timeframes(
        quote,
        primary_interval=interval,
        max_candles=max_candles,
    )
    return {
        "instrument": {
            "key": instrument.key,
            "symbol": instrument.symbol,
            "label": instrument.label,
            "source": instrument.source,
            "group": instrument.group,
        },
        "quote": {
            "price": quote.price,
            "price_label": quote.price_label(),
            "change": quote.change,
            "change_percent": quote.change_percent,
            "previous_close": quote.previous_close,
            "day_high": quote.day_high,
            "day_low": quote.day_low,
            "volume": quote.volume,
            "currency": quote.currency,
            "exchange": quote.exchange,
            "status": quote.status,
            "age_label": quote.age_label(),
            "last_error": quote.last_error,
        },
        "analysis": {
            "primary_interval": interval,
            "available_intervals": [item["interval"] for item in timeframes],
        },
        "candles": [_short_candle(candle) for candle in candles],
        "timeframes": timeframes,
        "session": {
            "recent_history": list(session_history),
            "instruction": (
                "Use recent_history only as prior discussion context. "
                "Current market data and multi-timeframe candles are authoritative."
            ),
        },
    }


def create_llm_provider(config: AgentConfig) -> LLMProvider:
    """说明：根据配置创建 LLM provider。"""
    from .model_registry import DEFAULT_AGENT_MODEL_REGISTRY

    return DEFAULT_AGENT_MODEL_REGISTRY.create_provider(config)


async def list_available_agent_models(
    config: AgentConfig, *, provider_override: str | None = None,
) -> list[dict[str, Any]]:
    """说明：列出指定或当前 Agent provider 可用的模型。"""
    from .model_registry import DEFAULT_AGENT_MODEL_REGISTRY

    return await DEFAULT_AGENT_MODEL_REGISTRY.list_available_models(
        config, provider_override=provider_override,
    )


_CODEX_COMPAT_EXPORTS = {
    "CodexProvider",
    "_access_token_is_expiring",
    "_codex_auth_path",
    "_codex_model_option",
    "_codex_request_headers",
    "_event_error_message",
    "_jwt_claims",
    "_read_codex_cli_credentials",
    "_resolve_codex_credentials",
    "_response_error_message",
}


def __getattr__(name: str) -> Any:
    """说明：为旧的 mytradebot.agent.provider Codex 导入保留兼容。"""
    if name in _CODEX_COMPAT_EXPORTS:
        from .providers import codex

        return getattr(codex, name)
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
