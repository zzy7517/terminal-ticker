"""Model/provider registry for agent runtimes."""
from __future__ import annotations

from dataclasses import dataclass
from typing import Awaitable, Callable

from ..config import AgentConfig
from ..config.agent_models import (
    ANTHROPIC_PROVIDER,
    CODEX_PROVIDER,
    AgentModelProfile,
    resolve_agent_model,
)
from .provider import LLMProvider, LLMProviderUnavailable

ProviderFactory = Callable[[AgentConfig, AgentModelProfile], LLMProvider]
ModelLister = Callable[[AgentConfig, AgentModelProfile], Awaitable[list[dict]]]


@dataclass(frozen=True)
class AgentModelProvider:
    """One registered model provider backend."""

    name: str
    factory: ProviderFactory
    list_models: ModelLister


class AgentModelRegistry:
    """Registry that resolves model config and instantiates providers."""

    def __init__(self) -> None:
        """初始化模型提供者注册表。"""
        self._providers: dict[str, AgentModelProvider] = {}

    def register(self, provider: AgentModelProvider) -> None:
        """注册一个模型提供者后端。"""
        self._providers[provider.name] = provider

    def resolve(self, config: AgentConfig) -> AgentModelProfile:
        """根据配置解析出对应的模型配置档案。"""
        return resolve_agent_model(config)

    def create_provider(self, config: AgentConfig) -> LLMProvider:
        """根据配置创建并返回对应的 LLM 提供者实例。"""
        profile = self.resolve(config)
        provider = self._providers.get(profile.provider)
        if provider is None:
            raise LLMProviderUnavailable(f"Unsupported agent provider: {profile.provider}")
        return provider.factory(config, profile)

    async def list_available_models(
        self, config: AgentConfig, *, provider_override: str | None = None,
    ) -> list[dict]:
        """列出指定提供者支持的所有可用模型。"""
        if provider_override:
            from ..config.agent_models import normalize_api_mode, normalize_model, normalize_reasoning_effort
            profile = AgentModelProfile(
                provider=provider_override,
                api_mode=normalize_api_mode(provider_override),
                model=normalize_model(provider_override, None),
                reasoning_effort=normalize_reasoning_effort(None),
                supports_reasoning=provider_override != "anthropic",
                requires_account_id=provider_override == "codex",
            )
        else:
            profile = self.resolve(config)
        provider = self._providers.get(profile.provider)
        if provider is None:
            raise LLMProviderUnavailable(f"Unsupported agent provider: {profile.provider}")
        return await provider.list_models(config, profile)


def default_agent_model_registry() -> AgentModelRegistry:
    """Build the built-in provider registry."""
    registry = AgentModelRegistry()

    def build_codex(config: AgentConfig, profile: AgentModelProfile) -> LLMProvider:
        """构建 Codex 提供者实例。"""
        from .providers.codex import CodexProvider

        return CodexProvider(config, profile)

    async def list_codex(config: AgentConfig, profile: AgentModelProfile) -> list[dict]:
        """列出 Codex 提供者支持的模型。"""
        from .providers.codex import CodexProvider

        return await CodexProvider(config, profile).list_models()

    def build_anthropic(config: AgentConfig, profile: AgentModelProfile) -> LLMProvider:
        """构建 Anthropic 提供者实例。"""
        from .providers.anthropic import AnthropicProvider

        return AnthropicProvider(config, profile)

    async def list_anthropic(config: AgentConfig, profile: AgentModelProfile) -> list[dict]:
        """列出 Anthropic 提供者支持的模型。"""
        from .providers.anthropic import AnthropicProvider

        return await AnthropicProvider(config, profile).list_models()

    registry.register(AgentModelProvider(CODEX_PROVIDER, build_codex, list_codex))
    registry.register(AgentModelProvider(ANTHROPIC_PROVIDER, build_anthropic, list_anthropic))
    return registry


DEFAULT_AGENT_MODEL_REGISTRY = default_agent_model_registry()
