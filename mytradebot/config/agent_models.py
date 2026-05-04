"""文件用途：Agent 模型配置，规范化 provider、model、api_mode 和推理强度。"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any

CODEX_PROVIDER = "codex"
OPENAI_PROVIDER = "openai"
CODEX_API_MODE = "codex_responses"
OPENAI_CHAT_API_MODE = "chat_completions"
DEFAULT_CODEX_BASE_URL = "https://chatgpt.com/backend-api/codex"
DEFAULT_CODEX_MODEL = "gpt-5.4-mini"
DEFAULT_OPENAI_MODEL = "gpt-4o"

SUPPORTED_AGENT_PROVIDERS = {CODEX_PROVIDER, OPENAI_PROVIDER}
SUPPORTED_API_MODES = {CODEX_API_MODE, OPENAI_CHAT_API_MODE}
SUPPORTED_REASONING_EFFORTS = {"low", "medium", "high", "xhigh"}

CODEX_MODEL_ALIASES = {
    "default": DEFAULT_CODEX_MODEL,
    "codex": DEFAULT_CODEX_MODEL,
    "fast": DEFAULT_CODEX_MODEL,
}


@dataclass(frozen=True)
class AgentModelProfile:
    """说明：封装一次 Agent 请求最终使用的模型配置。"""

    provider: str
    api_mode: str
    model: str
    reasoning_effort: str
    supports_reasoning: bool = True
    requires_account_id: bool = True


def normalize_provider(raw_value: Any) -> str:
    """说明：规范化并校验 Agent provider。"""
    if raw_value is None:
        return CODEX_PROVIDER
    if not isinstance(raw_value, str):
        raise ValueError("agent.provider must be a string")
    provider = raw_value.strip().lower()
    if not provider:
        return CODEX_PROVIDER
    if provider not in SUPPORTED_AGENT_PROVIDERS:
        supported = ", ".join(sorted(SUPPORTED_AGENT_PROVIDERS))
        raise ValueError(f"agent.provider must be one of: {supported}")
    return provider


def normalize_api_mode(provider: str, raw_value: Any = None) -> str:
    """说明：解析 provider 对应的 API 模式。"""
    if raw_value is None or raw_value == "":
        if provider == CODEX_PROVIDER:
            return CODEX_API_MODE
        if provider == OPENAI_PROVIDER:
            return OPENAI_CHAT_API_MODE
    if not isinstance(raw_value, str):
        raise ValueError("agent.api_mode must be a string")
    api_mode = raw_value.strip().lower()
    if not api_mode:
        return normalize_api_mode(provider)
    if provider == CODEX_PROVIDER and api_mode != CODEX_API_MODE:
        raise ValueError(f"agent.api_mode for codex must be {CODEX_API_MODE}")
    if provider == OPENAI_PROVIDER and api_mode != OPENAI_CHAT_API_MODE:
        raise ValueError(f"agent.api_mode for openai must be {OPENAI_CHAT_API_MODE}")
    if api_mode not in SUPPORTED_API_MODES:
        supported = ", ".join(sorted(SUPPORTED_API_MODES))
        raise ValueError(f"agent.api_mode must be one of: {supported}")
    return api_mode


def normalize_model(provider: str, raw_value: Any) -> str:
    """说明：规范化 provider 对应的模型名称。"""
    if raw_value is None:
        if provider == CODEX_PROVIDER:
            return DEFAULT_CODEX_MODEL
        if provider == OPENAI_PROVIDER:
            return DEFAULT_OPENAI_MODEL
        return ""
    if not isinstance(raw_value, str):
        raise ValueError("agent.model must be a string")
    model = raw_value.strip()
    if not model:
        if provider == CODEX_PROVIDER:
            return DEFAULT_CODEX_MODEL
        if provider == OPENAI_PROVIDER:
            return DEFAULT_OPENAI_MODEL
        return ""
    if provider == CODEX_PROVIDER:
        return CODEX_MODEL_ALIASES.get(model.lower(), model)
    return model


def normalize_reasoning_effort(raw_value: Any) -> str:
    """说明：规范化模型推理强度。"""
    if raw_value is None:
        return "medium"
    if not isinstance(raw_value, str):
        raise ValueError("agent.reasoning_effort must be a string")
    effort = raw_value.strip().lower()
    if not effort:
        return "medium"
    aliases = {"minimal": "low", "extra": "xhigh", "extra_high": "xhigh"}
    normalized = aliases.get(effort, effort)
    if normalized not in SUPPORTED_REASONING_EFFORTS:
        supported = ", ".join(sorted(SUPPORTED_REASONING_EFFORTS))
        raise ValueError(f"agent.reasoning_effort must be one of: {supported}")
    return normalized


def resolve_agent_model(config: Any) -> AgentModelProfile:
    """说明：把 AgentConfig 解析为最终模型配置。"""
    provider = normalize_provider(getattr(config, "provider", None))
    api_mode = normalize_api_mode(provider, getattr(config, "api_mode", None))
    model = normalize_model(provider, getattr(config, "model", None))
    reasoning_effort = normalize_reasoning_effort(getattr(config, "reasoning_effort", None))
    if provider == CODEX_PROVIDER:
        return AgentModelProfile(
            provider=provider,
            api_mode=api_mode,
            model=model,
            reasoning_effort=reasoning_effort,
        )
    if provider == OPENAI_PROVIDER:
        return AgentModelProfile(
            provider=provider,
            api_mode=api_mode,
            model=model,
            reasoning_effort=reasoning_effort,
            supports_reasoning=False,
            requires_account_id=False,
        )
    raise ValueError(f"Unsupported agent provider: {provider}")
