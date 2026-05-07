"""文件用途：API 层通用辅助函数 — 请求校验、配置转换。"""
from __future__ import annotations

import logging
import math
import urllib.parse
from typing import Any

from fastapi import HTTPException, Request

from ..config import (
    AgentConfig,
    AnalysisConfig,
    NewsConfig,
    SocialFeedConfig,
    parse_agent_config,
    parse_analysis_config,
    parse_news_config,
    parse_social_feed_config,
)
from ..config.agent_models import (
    normalize_api_mode,
    normalize_model,
    normalize_provider,
)

LOGGER = logging.getLogger(__name__)
LOCAL_HOSTS = {"127.0.0.1", "localhost", "::1"}


def agent_tool_audit_hook(call: Any, result: Any, tool: Any) -> None:
    LOGGER.info(
        "agent tool finished: name=%s error=%s output_chars=%d",
        getattr(call, "name", getattr(tool, "name", "unknown")),
        bool(getattr(result, "error", False)),
        len(str(getattr(result, "output", ""))),
    )


def normalize_agent_prompt(prompt: str | None, default: str) -> str:
    text = (prompt or "").strip()
    return text or default


def require_local_request(request: Request, *, feature_name: str) -> None:
    client_host = (request.client.host if request.client else "").lower()
    if client_host and client_host not in LOCAL_HOSTS and client_host != "testclient":
        raise HTTPException(status_code=403, detail=f"{feature_name} API is local-only")
    raw_host = (request.headers.get("host") or "").strip().lower()
    if raw_host.startswith("[") and "]" in raw_host:
        host = raw_host.split("]", 1)[0].strip("[]")
    else:
        host = raw_host.split(":", 1)[0]
    if host not in LOCAL_HOSTS and not (client_host == "testclient" and host == "testserver"):
        LOGGER.warning("%s API request used non-loopback Host header: %s", feature_name, raw_host)
    origin = request.headers.get("origin")
    if origin:
        origin_host = (urllib.parse.urlparse(origin).hostname or "").lower()
        if origin_host not in LOCAL_HOSTS:
            raise HTTPException(status_code=403, detail=f"{feature_name} API origin denied")


def require_local_social_request(request: Request) -> None:
    require_local_request(request, feature_name="social feed")


def require_local_trading_request(request: Request) -> None:
    require_local_request(request, feature_name="trading")


def request_float(raw_value: Any, field_name: str) -> float:
    try:
        value = float(raw_value)
    except (TypeError, ValueError) as exc:
        raise HTTPException(status_code=400, detail=f"{field_name} must be a number") from exc
    if not math.isfinite(value):
        raise HTTPException(status_code=400, detail=f"{field_name} must be finite")
    return value


def effective_agent_config(
    base: AgentConfig,
    override_provider: str | None = None,
    override_model: str | None = None,
) -> AgentConfig:
    if not override_provider and not override_model:
        return base
    provider = normalize_provider(override_provider) if override_provider else base.provider
    model = normalize_model(provider, override_model) if override_model else normalize_model(provider, None)
    api_mode = normalize_api_mode(provider)
    profile = base.provider_profiles.get(provider)
    reasoning_effort = profile.effort_for(model) if profile is not None else base.reasoning_effort
    return AgentConfig(
        enabled=True,
        provider=provider,
        api_mode=api_mode,
        model=model,
        max_candles=base.max_candles,
        reasoning_effort=reasoning_effort,
        provider_profiles=base.provider_profiles,
    )


def agent_config_from_payload(current: AgentConfig, payload: dict[str, Any]) -> AgentConfig:
    profiles = dict(current.provider_profiles)
    raw: dict[str, Any] = {
        "enabled": current.enabled,
        "max_candles": current.max_candles,
        "providers": {
            name: {
                "enabled": p.enabled,
                "models": list(p.models),
                "model_efforts": dict(p.model_efforts),
            }
            for name, p in profiles.items()
        },
    }
    field_map = {
        "enabled": "enabled",
        "maxCandles": "max_candles",
        "max_candles": "max_candles",
    }
    for incoming, normalized in field_map.items():
        if incoming in payload:
            raw[normalized] = payload[incoming]
    return parse_agent_config(raw)


def analysis_config_from_payload(current: AnalysisConfig, payload: dict[str, Any]) -> AnalysisConfig:
    raw: dict[str, Any] = {
        "enabled": current.enabled,
        "interval": current.interval,
        "lookback": current.lookback,
        "poll_interval_seconds": current.poll_interval_seconds,
        "stale_after_seconds": current.stale_after_seconds,
    }
    field_map = {
        "enabled": "enabled",
        "interval": "interval",
        "lookback": "lookback",
        "pollIntervalSeconds": "poll_interval_seconds",
        "poll_interval_seconds": "poll_interval_seconds",
        "staleAfterSeconds": "stale_after_seconds",
        "stale_after_seconds": "stale_after_seconds",
    }
    for incoming, normalized in field_map.items():
        if incoming in payload:
            raw[normalized] = payload[incoming]
    return parse_analysis_config(raw)


def news_config_from_payload(current: NewsConfig, payload: dict[str, Any]) -> NewsConfig:
    raw: dict[str, Any] = {
        "enabled": current.enabled,
        "poll_interval_seconds": current.poll_interval_seconds,
        "max_interval_seconds": current.max_interval_seconds,
        "reuters_url": current.reuters_url,
        "request_timeout_seconds": current.request_timeout_seconds,
        "retention_days": current.retention_days,
        "recent_limit": current.recent_limit,
    }
    field_map = {
        "enabled": "enabled",
        "pollIntervalSeconds": "poll_interval_seconds",
        "poll_interval_seconds": "poll_interval_seconds",
        "maxIntervalSeconds": "max_interval_seconds",
        "max_interval_seconds": "max_interval_seconds",
        "reutersUrl": "reuters_url",
        "reuters_url": "reuters_url",
        "requestTimeoutSeconds": "request_timeout_seconds",
        "request_timeout_seconds": "request_timeout_seconds",
        "retentionDays": "retention_days",
        "retention_days": "retention_days",
        "recentLimit": "recent_limit",
        "recent_limit": "recent_limit",
    }
    for incoming, normalized in field_map.items():
        if incoming in payload:
            raw[normalized] = payload[incoming]
    return parse_news_config(raw)


def social_feed_config_from_payload(
    current: SocialFeedConfig,
    payload: dict[str, Any],
) -> SocialFeedConfig:
    raw: dict[str, Any] = {
        "enabled": current.enabled,
        "recent_limit": current.recent_limit,
        "retention_days": current.retention_days,
        "max_items": current.max_items,
    }
    field_map = {
        "enabled": "enabled",
        "recentLimit": "recent_limit",
        "recent_limit": "recent_limit",
        "retentionDays": "retention_days",
        "retention_days": "retention_days",
        "maxItems": "max_items",
        "max_items": "max_items",
    }
    for incoming, normalized in field_map.items():
        if incoming in payload:
            raw[normalized] = payload[incoming]
    return parse_social_feed_config(raw)
