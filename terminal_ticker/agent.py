"""LLM-backed market analysis agent framework."""
from __future__ import annotations

import base64
import json
import os
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Protocol

import httpx

from .config import AgentConfig
from .llm_models import (
    AgentModelProfile,
    CODEX_API_MODE,
    CODEX_PROVIDER,
    DEFAULT_CODEX_BASE_URL,
    resolve_agent_model,
)
from .models import QuoteState
from .price_action import Candle
from .providers import MarketInstrument

CODEX_ENV_API_KEYS = ("TERMINAL_TICKER_CODEX_API_KEY", "CODEX_API_KEY")
CODEX_ENV_BASE_URL = "TERMINAL_TICKER_CODEX_BASE_URL"

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


class LLMProviderUnavailable(RuntimeError):
    """Raised when a configured provider lacks credentials or runtime support."""


class LLMProviderError(RuntimeError):
    """Raised when a provider call fails after credentials are available."""


class LLMProvider(Protocol):
    """Interface for an LLM-backed market analysis provider."""

    name: str
    model: str

    async def analyze(self, context: dict[str, Any]) -> "AgentAnalysisResult":
        """Analyze one market context."""


@dataclass(frozen=True)
class AgentAnalysisResult:
    """Normalized output from any LLM provider."""

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
        """Build a result for unavailable provider or invalid output."""
        return cls(
            available=False,
            provider=provider,
            model=model,
            updated_at=_utc_now_iso(),
            error=error,
            raw_text=raw_text,
        )

    def to_payload(self) -> dict[str, Any]:
        """Serialize for FastAPI responses and the browser UI."""
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
    """Return current UTC time as ISO text."""
    return datetime.now(timezone.utc).isoformat()


def _short_candle(candle: Candle) -> dict[str, Any]:
    """Serialize one candle into compact agent input."""
    return {
        "time": candle.open_time_ms // 1000,
        "open": candle.open,
        "high": candle.high,
        "low": candle.low,
        "close": candle.close,
        "volume": candle.volume,
    }


def _price_action_dict(quote: QuoteState) -> dict[str, Any] | None:
    """Return the deterministic price action state for agent input."""
    state = quote.price_action
    if state is None:
        return None
    return {
        "label": state.label,
        "bias": state.bias,
        "marker": state.marker,
        "reason": state.reason,
        "strength": state.strength,
        "available": state.is_available(),
        "error": state.error,
        "updated_at": state.updated_at.isoformat(),
    }


def _candle_facts(candles: tuple[Candle, ...]) -> dict[str, Any]:
    """Derive deterministic facts that help the LLM avoid redoing boilerplate math."""
    if not candles:
        return {}
    recent = candles[-min(10, len(candles)):]
    latest = candles[-1]
    previous = candles[:-1]
    facts: dict[str, Any] = {
        "latest_close": latest.close,
        "latest_body": abs(latest.close - latest.open),
        "latest_range": latest.range,
        "recent_high": max(candle.high for candle in recent),
        "recent_low": min(candle.low for candle in recent),
        "recent_volume_avg": sum(candle.volume for candle in recent) / len(recent),
    }
    if previous:
        previous_slice = previous[-min(9, len(previous)):]
        facts["previous_high"] = max(candle.high for candle in previous_slice)
        facts["previous_low"] = min(candle.low for candle in previous_slice)
    return facts


def build_agent_context(
    *,
    instrument: MarketInstrument,
    quote: QuoteState,
    interval: str,
    max_candles: int,
) -> dict[str, Any]:
    """Build the structured context sent to the LLM provider."""
    candles = tuple(quote.price_action_candles[-max_candles:])
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
            "interval": interval,
            "deterministic_price_action": _price_action_dict(quote),
            "candle_facts": _candle_facts(candles),
        },
        "candles": [_short_candle(candle) for candle in candles],
    }


def create_llm_provider(config: AgentConfig) -> LLMProvider:
    """Create the configured LLM provider."""
    profile = resolve_agent_model(config)
    if profile.provider == CODEX_PROVIDER:
        return CodexProvider(config, profile)
    raise LLMProviderUnavailable(f"Unsupported agent provider: {profile.provider}")


class CodexProvider:
    """Codex provider backed by a Responses-style API call."""

    name = CODEX_PROVIDER

    def __init__(self, config: AgentConfig, profile: AgentModelProfile | None = None) -> None:
        """Create a Codex provider from app config."""
        self.config = config
        self.profile = profile or resolve_agent_model(config)
        if self.profile.api_mode != CODEX_API_MODE:
            raise LLMProviderUnavailable(f"Unsupported Codex api_mode: {self.profile.api_mode}")
        self.model = self.profile.model

    async def analyze(self, context: dict[str, Any]) -> AgentAnalysisResult:
        """Analyze one structured market context through Codex."""
        try:
            credentials = _resolve_codex_credentials(self.profile)
            response_data = await self._request_analysis(credentials, context)
            text = _extract_response_text(response_data)
            if not text:
                return AgentAnalysisResult.unavailable(
                    provider=self.name,
                    model=self.model,
                    error="Codex returned no output text.",
                )
            return _result_from_text(text, provider=self.name, model=self.model)
        except LLMProviderUnavailable as exc:
            return AgentAnalysisResult.unavailable(
                provider=self.name,
                model=self.model,
                error=str(exc),
            )
        except Exception as exc:
            return AgentAnalysisResult.unavailable(
                provider=self.name,
                model=self.model,
                error=str(exc) or exc.__class__.__name__,
            )

    async def _request_analysis(
        self,
        credentials: dict[str, str],
        context: dict[str, Any],
    ) -> dict[str, Any]:
        """Call the Codex Responses-style streaming endpoint."""
        base_url = credentials["base_url"].rstrip("/")
        payload: dict[str, Any] = {
            "model": self.model,
            "instructions": AGENT_INSTRUCTIONS,
            "input": [
                {
                    "role": "user",
                    "content": [
                        {
                            "type": "input_text",
                            "text": json.dumps(context, ensure_ascii=False, separators=(",", ":")),
                        }
                    ],
                }
            ],
            "store": False,
            "stream": True,
            "reasoning": {
                "effort": self.profile.reasoning_effort,
                "summary": "auto",
            },
        }
        headers = {
            "Authorization": f"Bearer {credentials['api_key']}",
            "Content-Type": "application/json",
            **_codex_request_headers(credentials["api_key"], credentials.get("account_id")),
        }
        timeout = httpx.Timeout(self.config.timeout_seconds)
        async with httpx.AsyncClient(timeout=timeout) as client:
            async with client.stream(
                "POST",
                f"{base_url}/responses",
                json=payload,
                headers=headers,
            ) as response:
                if response.status_code >= 400:
                    body = (await response.aread()).decode(errors="replace")
                    raise LLMProviderError(_response_error_message(response.status_code, body))
                output_text = await _collect_response_stream_text(response)
        return {"output_text": output_text}

    async def list_models(self) -> list[dict[str, Any]]:
        """Fetch Codex models visible to the current account."""
        credentials = _resolve_codex_credentials(self.profile)
        base_url = credentials["base_url"].rstrip("/")
        headers = {
            "Authorization": f"Bearer {credentials['api_key']}",
            **_codex_request_headers(credentials["api_key"], credentials.get("account_id")),
        }
        timeout = httpx.Timeout(self.config.timeout_seconds)
        async with httpx.AsyncClient(timeout=timeout) as client:
            response = await client.get(
                f"{base_url}/models",
                params={"client_version": "1.0.0"},
                headers=headers,
            )
        if response.status_code >= 400:
            raise LLMProviderError(_response_error_message(response.status_code, response.text))
        data = response.json()
        if not isinstance(data, dict) or not isinstance(data.get("models"), list):
            raise LLMProviderError("Codex returned an invalid model list.")
        return [_codex_model_option(item) for item in data["models"] if isinstance(item, dict)]


async def list_available_agent_models(config: AgentConfig) -> list[dict[str, Any]]:
    """List available models for the configured provider."""
    profile = resolve_agent_model(config)
    if profile.provider == CODEX_PROVIDER:
        return await CodexProvider(config, profile).list_models()
    raise LLMProviderUnavailable(f"Unsupported agent provider: {profile.provider}")


async def _collect_response_stream_text(response: httpx.Response) -> str:
    """Collect output_text from Codex Responses server-sent events."""
    chunks: list[str] = []
    done_text: str | None = None
    async for line in response.aiter_lines():
        if not line.startswith("data: "):
            continue
        raw_data = line.removeprefix("data: ").strip()
        if not raw_data or raw_data == "[DONE]":
            continue
        try:
            event = json.loads(raw_data)
        except json.JSONDecodeError:
            continue
        if not isinstance(event, dict):
            continue
        event_type = event.get("type")
        if event_type == "response.output_text.delta":
            delta = event.get("delta")
            if isinstance(delta, str):
                chunks.append(delta)
        elif event_type == "response.output_text.done":
            text = event.get("text")
            if isinstance(text, str):
                done_text = text
        elif event_type in {"response.failed", "response.incomplete", "error"}:
            raise LLMProviderError(_event_error_message(event))
    text = "".join(chunks).strip()
    if text:
        return text
    return (done_text or "").strip()


def _response_error_message(status_code: int, body: str) -> str:
    """Return a compact provider error without leaking credentials."""
    detail = ""
    try:
        payload = json.loads(body)
        if isinstance(payload, dict):
            raw_detail = payload.get("detail") or payload.get("error") or payload.get("message")
            if isinstance(raw_detail, dict):
                detail = str(raw_detail.get("message") or raw_detail)
            elif raw_detail is not None:
                detail = str(raw_detail)
    except json.JSONDecodeError:
        detail = body.strip()
    suffix = f": {detail.strip()}" if detail.strip() else ""
    return f"Codex request failed: HTTP {status_code}{suffix}"


def _event_error_message(event: dict[str, Any]) -> str:
    """Normalize a Responses stream failure event."""
    error = event.get("error")
    if isinstance(error, dict):
        message = error.get("message") or error.get("code") or error
        return f"Codex request failed: {message}"
    if isinstance(error, str):
        return f"Codex request failed: {error}"
    return f"Codex request failed: {event.get('type') or 'stream error'}"


def _codex_model_option(item: dict[str, Any]) -> dict[str, Any]:
    """Normalize one Codex model object for the browser UI."""
    levels = item.get("supported_reasoning_levels")
    reasoning_efforts: list[str] = []
    if isinstance(levels, list):
        for level in levels:
            if isinstance(level, dict) and isinstance(level.get("effort"), str):
                reasoning_efforts.append(level["effort"])
    return {
        "slug": str(item.get("slug") or ""),
        "displayName": str(item.get("display_name") or item.get("slug") or ""),
        "description": str(item.get("description") or ""),
        "visibility": str(item.get("visibility") or ""),
        "supportedInApi": bool(item.get("supported_in_api", True)),
        "defaultReasoningEffort": str(item.get("default_reasoning_level") or ""),
        "supportedReasoningEfforts": reasoning_efforts,
        "contextWindow": item.get("context_window") if isinstance(item.get("context_window"), int) else None,
        "preferWebsockets": bool(item.get("prefer_websockets", False)),
    }


def _resolve_codex_credentials(profile: AgentModelProfile) -> dict[str, str]:
    """Resolve Codex credentials from env or the local Codex CLI auth store."""
    api_key = _first_env(CODEX_ENV_API_KEYS)
    env_base_url = os.getenv(CODEX_ENV_BASE_URL, "").strip()
    base_url = (
        profile.base_url
        if profile.base_url_configured
        else env_base_url
        or profile.base_url
        or DEFAULT_CODEX_BASE_URL
    )
    if api_key:
        return {"api_key": api_key, "base_url": base_url}

    codex = _read_codex_cli_credentials()
    if codex:
        return {
            "api_key": codex["api_key"],
            "base_url": base_url,
            "account_id": codex.get("account_id", ""),
        }

    raise LLMProviderUnavailable(
        "No Codex credential found. Set TERMINAL_TICKER_CODEX_API_KEY "
        "or login with the Codex CLI so ~/.codex/auth.json contains valid tokens."
    )


def _first_env(names: tuple[str, ...]) -> str | None:
    """Return the first non-empty environment variable value."""
    for name in names:
        value = os.getenv(name, "").strip()
        if value:
            return value
    return None


def _codex_auth_path() -> Path:
    """Return the Codex CLI auth file path."""
    codex_home = os.getenv("CODEX_HOME", "").strip()
    if not codex_home:
        codex_home = str(Path.home() / ".codex")
    return Path(codex_home).expanduser() / "auth.json"


def _read_codex_cli_credentials() -> dict[str, str] | None:
    """Read Codex CLI ChatGPT tokens without importing or mutating Hermes."""
    auth_path = _codex_auth_path()
    if not auth_path.is_file():
        return None
    try:
        payload = json.loads(auth_path.read_text(encoding="utf-8"))
    except Exception:
        return None
    if not isinstance(payload, dict):
        return None
    tokens = payload.get("tokens")
    if not isinstance(tokens, dict):
        return None
    access_token = str(tokens.get("access_token") or "").strip()
    if not access_token:
        return None
    if _access_token_is_expiring(access_token, skew_seconds=0):
        raise LLMProviderUnavailable(
            "Codex CLI access token is expired. Run `codex` once to refresh the login."
        )
    account_id = str(tokens.get("account_id") or "").strip()
    if not account_id:
        claims = _jwt_claims(access_token)
        account_id = str(
            claims.get("chatgpt_account_id")
            or claims.get("https://api.openai.com/auth", {}).get("chatgpt_account_id")
            or ""
        ).strip()
    return {"api_key": access_token, "account_id": account_id}


def _access_token_is_expiring(access_token: str, *, skew_seconds: int) -> bool:
    """Return whether a JWT access token is expired or about to expire."""
    claims = _jwt_claims(access_token)
    exp = claims.get("exp")
    if not isinstance(exp, (int, float)):
        return False
    return float(exp) <= time.time() + max(0, skew_seconds)


def _jwt_claims(token: str) -> dict[str, Any]:
    """Decode JWT claims without verifying signature for local metadata use."""
    try:
        parts = token.split(".")
        if len(parts) < 2:
            return {}
        payload_b64 = parts[1] + "=" * (-len(parts[1]) % 4)
        claims = json.loads(base64.urlsafe_b64decode(payload_b64))
    except Exception:
        return {}
    return claims if isinstance(claims, dict) else {}


def _codex_request_headers(access_token: str, account_id: str | None = None) -> dict[str, str]:
    """Mirror the Codex CLI-shaped headers used by Hermes for chatgpt.com."""
    headers = {
        "User-Agent": "codex_cli_rs/0.0.0 (Terminal Ticker)",
        "originator": "codex_cli_rs",
    }
    if isinstance(account_id, str) and account_id.strip():
        headers["ChatGPT-Account-ID"] = account_id.strip()
        return headers
    claims = _jwt_claims(access_token)
    token_account_id = (
        claims.get("chatgpt_account_id")
        or claims.get("https://api.openai.com/auth", {}).get("chatgpt_account_id")
    )
    if isinstance(token_account_id, str) and token_account_id:
        headers["ChatGPT-Account-ID"] = token_account_id
    return headers


def _extract_response_text(data: dict[str, Any]) -> str:
    """Extract output text from common Responses API response shapes."""
    output_text = data.get("output_text")
    if isinstance(output_text, str) and output_text.strip():
        return output_text.strip()
    text_parts: list[str] = []
    output = data.get("output")
    if isinstance(output, list):
        for item in output:
            if not isinstance(item, dict):
                continue
            content = item.get("content")
            if isinstance(content, str):
                text_parts.append(content)
            elif isinstance(content, list):
                for part in content:
                    if not isinstance(part, dict):
                        continue
                    text = part.get("text")
                    if isinstance(text, str):
                        text_parts.append(text)
    return "".join(text_parts).strip()


def _result_from_text(text: str, *, provider: str, model: str) -> AgentAnalysisResult:
    """Parse and normalize the JSON-only model response."""
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
    """Load the first JSON object from model text."""
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
    """Coerce a scalar into display text."""
    if value is None:
        return ""
    if isinstance(value, str):
        return value.strip()
    return str(value).strip()


def _normalize_bias(value: Any) -> str:
    """Normalize provider bias labels."""
    bias = _coerce_text(value).lower()
    if bias in {"bullish", "bearish", "neutral", "mixed"}:
        return bias
    return "neutral"


def _normalize_confidence(value: Any) -> int:
    """Normalize confidence to 0-100."""
    try:
        confidence = int(value)
    except (TypeError, ValueError):
        return 0
    return max(0, min(100, confidence))


def _normalize_text_list(value: Any) -> tuple[str, ...]:
    """Normalize a list of short text strings."""
    if not isinstance(value, list):
        return tuple()
    items = tuple(_coerce_text(item) for item in value)
    return tuple(item for item in items if item)


def _normalize_key_levels(value: Any) -> tuple[dict[str, Any], ...]:
    """Normalize key level rows."""
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
