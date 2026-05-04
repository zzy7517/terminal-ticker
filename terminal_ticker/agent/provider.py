"""文件用途：Agent 层，构造行情上下文、调用 LLM，并规范化模型输出。"""
from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Protocol

from ..config import AgentConfig
from ..config.agent_models import (
    CODEX_PROVIDER,
    OPENAI_PROVIDER,
    resolve_agent_model,
)
from ..domain.quotes import QuoteState
from ..domain.price_action import Candle
from ..market_data.router import MarketInstrument

AGENT_INSTRUCTIONS = """你是一个本地运行的 price action trading assistant。
你只分析用户提供的结构化行情数据和 OHLCV K 线，不读取截图，不假设缺失数据。
你不下单、不管理仓位、不承诺收益，也不把分析表述成确定性金融建议。
只输出一个 JSON object，字段必须是：
summary: string
bias: "bullish" | "bearish" | "neutral" | "mixed"
confidence: integer 0-100
key_levels: array of {label: string, price: number | null, reason: string}
watch_plan: array of string
invalidation: string
risk_notes: array of string
"""

# TODO: add chart snapshot export and structured drawing instructions for a future
# vision-enabled agent pass, so the model can inspect the rendered chart and
# propose drawings without taking over the front-end rendering itself.


class LLMProviderUnavailable(RuntimeError):
    """说明：表示模型 provider 缺少凭证或运行环境不可用。"""


class LLMProviderError(RuntimeError):
    """说明：表示模型 provider 请求失败但配置本身可用。"""


class LLMProvider(Protocol):
    """说明：定义所有 LLM 分析 provider 必须实现的接口。"""

    name: str
    model: str

    async def analyze(self, context: dict[str, Any]) -> "AgentAnalysisResult":
        """说明：分析一个结构化行情上下文。"""


@dataclass(frozen=True)
class AgentAnalysisResult:
    """说明：封装任意 LLM provider 返回的标准化分析结果。"""

    available: bool
    provider: str
    model: str
    updated_at: str
    summary: str = ""
    bias: str = "neutral"
    confidence: int = 0
    key_levels: tuple[dict[str, Any], ...] = tuple()
    watch_plan: tuple[str, ...] = tuple()
    invalidation: str = ""
    risk_notes: tuple[str, ...] = tuple()
    error: str | None = None
    raw_text: str | None = None

    @classmethod
    def unavailable(
        cls,
        *,
        provider: str,
        model: str,
        error: str,
        raw_text: str | None = None,
    ) -> "AgentAnalysisResult":
        """说明：构造一个不可用的标准结果。"""
        return cls(
            available=False,
            provider=provider,
            model=model,
            updated_at=_utc_now_iso(),
            error=error,
            raw_text=raw_text,
        )

    def to_payload(self) -> dict[str, Any]:
        """说明：把对象转换成 API 和前端可用的载荷。"""
        return {
            "available": self.available,
            "provider": self.provider,
            "model": self.model,
            "updatedAt": self.updated_at,
            "summary": self.summary,
            "bias": self.bias,
            "confidence": self.confidence,
            "keyLevels": list(self.key_levels),
            "watchPlan": list(self.watch_plan),
            "invalidation": self.invalidation,
            "riskNotes": list(self.risk_notes),
            "error": self.error,
            "rawText": self.raw_text,
        }


def _utc_now_iso() -> str:
    """说明：返回当前 UTC 时间的 ISO 字符串。"""
    return datetime.now(timezone.utc).isoformat()


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
    profile = resolve_agent_model(config)
    if profile.provider == CODEX_PROVIDER:
        from .providers.codex import CodexProvider

        return CodexProvider(config, profile)
    if profile.provider == OPENAI_PROVIDER:
        from .providers.openai_chat import OpenAIChatProvider

        return OpenAIChatProvider(config, profile)
    raise LLMProviderUnavailable(f"Unsupported agent provider: {profile.provider}")


async def list_available_agent_models(config: AgentConfig) -> list[dict[str, Any]]:
    """说明：列出当前 Agent provider 可用的模型。"""
    profile = resolve_agent_model(config)
    if profile.provider == CODEX_PROVIDER:
        from .providers.codex import CodexProvider

        return await CodexProvider(config, profile).list_models()
    if profile.provider == OPENAI_PROVIDER:
        from .providers.openai_chat import OpenAIChatProvider

        return await OpenAIChatProvider(config, profile).list_models()
    raise LLMProviderUnavailable(f"Unsupported agent provider: {profile.provider}")


def _result_from_text(text: str, *, provider: str, model: str) -> AgentAnalysisResult:
    """说明：把模型返回的 JSON 文本转换成标准分析结果。"""
    try:
        payload = _load_json_object(text)
    except ValueError as exc:
        return AgentAnalysisResult.unavailable(
            provider=provider,
            model=model,
            error=str(exc),
            raw_text=text,
        )

    return AgentAnalysisResult(
        available=True,
        provider=provider,
        model=model,
        updated_at=_utc_now_iso(),
        summary=_coerce_text(payload.get("summary")),
        bias=_normalize_bias(payload.get("bias")),
        confidence=_normalize_confidence(payload.get("confidence")),
        key_levels=_normalize_key_levels(payload.get("key_levels")),
        watch_plan=_normalize_text_list(payload.get("watch_plan")),
        invalidation=_coerce_text(payload.get("invalidation")),
        risk_notes=_normalize_text_list(payload.get("risk_notes")),
        raw_text=text,
    )


def _load_json_object(text: str) -> dict[str, Any]:
    """说明：从模型输出中读取第一个 JSON object。"""
    try:
        data = json.loads(text)
    except json.JSONDecodeError:
        start = text.find("{")
        end = text.rfind("}")
        if start < 0 or end <= start:
            raise ValueError("Codex output was not JSON.")
        try:
            data = json.loads(text[start : end + 1])
        except json.JSONDecodeError as exc:
            raise ValueError("Codex output JSON could not be parsed.") from exc
    if not isinstance(data, dict):
        raise ValueError("Codex output JSON must be an object.")
    return data


def _coerce_text(value: Any) -> str:
    """说明：把任意标量转换成展示文本。"""
    if value is None:
        return ""
    if isinstance(value, str):
        return value.strip()
    return str(value).strip()


def _normalize_bias(value: Any) -> str:
    """说明：规范化模型返回的方向标签。"""
    bias = _coerce_text(value).lower()
    if bias in {"bullish", "bearish", "neutral", "mixed"}:
        return bias
    return "neutral"


def _normalize_confidence(value: Any) -> int:
    """说明：把置信度限制在 0 到 100。"""
    try:
        confidence = int(value)
    except (TypeError, ValueError):
        return 0
    return max(0, min(100, confidence))


def _normalize_text_list(value: Any) -> tuple[str, ...]:
    """说明：规范化短文本列表。"""
    if not isinstance(value, list):
        return tuple()
    items = tuple(_coerce_text(item) for item in value)
    return tuple(item for item in items if item)


def _normalize_key_levels(value: Any) -> tuple[dict[str, Any], ...]:
    """说明：规范化关键价位列表。"""
    if not isinstance(value, list):
        return tuple()
    rows: list[dict[str, Any]] = []
    for item in value:
        if not isinstance(item, dict):
            continue
        price = item.get("price")
        if price is not None:
            try:
                price = float(price)
            except (TypeError, ValueError):
                price = None
        rows.append(
            {
                "label": _coerce_text(item.get("label")),
                "price": price,
                "reason": _coerce_text(item.get("reason")),
            }
        )
    return tuple(rows)


_CODEX_COMPAT_EXPORTS = {
    "CodexProvider",
    "_access_token_is_expiring",
    "_codex_auth_path",
    "_codex_model_option",
    "_codex_request_headers",
    "_collect_response_stream_text",
    "_event_error_message",
    "_extract_response_text",
    "_jwt_claims",
    "_read_codex_cli_credentials",
    "_resolve_codex_credentials",
    "_response_error_message",
}


def __getattr__(name: str) -> Any:
    """说明：为旧的 terminal_ticker.agent.provider Codex 导入保留兼容。"""
    if name in _CODEX_COMPAT_EXPORTS:
        from .providers import codex

        return getattr(codex, name)
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
