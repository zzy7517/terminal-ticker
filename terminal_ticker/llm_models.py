"""Resolve agent provider and model configuration."""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any

CODEX_PROVIDER = "codex"
CODEX_API_MODE = "codex_responses"
DEFAULT_CODEX_BASE_URL = "https://chatgpt.com/backend-api/codex"
DEFAULT_CODEX_MODEL = "gpt-5.4-mini"

SUPPORTED_AGENT_PROVIDERS = {CODEX_PROVIDER}
SUPPORTED_API_MODES = {CODEX_API_MODE}
SUPPORTED_REASONING_EFFORTS = {"low", "medium", "high", "xhigh"}

CODEX_MODEL_ALIASES = {
    "default": DEFAULT_CODEX_MODEL,
    "codex": DEFAULT_CODEX_MODEL,
    "fast": DEFAULT_CODEX_MODEL,
}

CODEX_KNOWN_MODELS = (
    "gpt-5.5",
    "gpt-5.4-mini",
    "gpt-5.4",
    "gpt-5.3-codex",
    "gpt-5.2",
    "gpt-5.2-codex",
    "gpt-5.1-codex-max",
    "gpt-5.1-codex-mini",
)


@dataclass(frozen=True)
class AgentModelProfile:
    """Resolved provider/model behavior for one agent request path."""

    provider: str
    api_mode: str
    model: str
    base_url: str
    reasoning_effort: str
    base_url_configured: bool = False
    supports_reasoning: bool = True
    requires_account_id: bool = True


def normalize_provider(raw_value: Any) -> str:
    """Normalize and validate the configured provider."""
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
    """Resolve the API mode for a provider."""
    if raw_value is None or raw_value == "":
        if provider == CODEX_PROVIDER:
            return CODEX_API_MODE
    if not isinstance(raw_value, str):
        raise ValueError("agent.api_mode must be a string")
    api_mode = raw_value.strip().lower()
    if not api_mode:
        return normalize_api_mode(provider)
    if provider == CODEX_PROVIDER and api_mode != CODEX_API_MODE:
        raise ValueError(f"agent.api_mode for codex must be {CODEX_API_MODE}")
    if api_mode not in SUPPORTED_API_MODES:
        supported = ", ".join(sorted(SUPPORTED_API_MODES))
        raise ValueError(f"agent.api_mode must be one of: {supported}")
    return api_mode


def normalize_model(provider: str, raw_value: Any) -> str:
    """Normalize the configured model for a provider."""
    if raw_value is None:
        return DEFAULT_CODEX_MODEL if provider == CODEX_PROVIDER else ""
    if not isinstance(raw_value, str):
        raise ValueError("agent.model must be a string")
    model = raw_value.strip()
    if not model:
        return DEFAULT_CODEX_MODEL if provider == CODEX_PROVIDER else ""
    if provider == CODEX_PROVIDER:
        return CODEX_MODEL_ALIASES.get(model.lower(), model)
    return model


def normalize_reasoning_effort(raw_value: Any) -> str:
    """Normalize the configured reasoning effort for Responses-style models."""
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
    """Resolve an AgentConfig-like object into a concrete model profile."""
    provider = normalize_provider(getattr(config, "provider", None))
    api_mode = normalize_api_mode(provider, getattr(config, "api_mode", None))
    model = normalize_model(provider, getattr(config, "model", None))
    reasoning_effort = normalize_reasoning_effort(getattr(config, "reasoning_effort", None))
    raw_base_url = getattr(config, "base_url", None)
    base_url = raw_base_url or DEFAULT_CODEX_BASE_URL
    if provider == CODEX_PROVIDER:
        return AgentModelProfile(
            provider=provider,
            api_mode=api_mode,
            model=model,
            base_url=str(base_url).rstrip("/"),
            base_url_configured=bool(raw_base_url),
            reasoning_effort=reasoning_effort,
        )
    raise ValueError(f"Unsupported agent provider: {provider}")
