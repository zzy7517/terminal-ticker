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
        self._providers: dict[str, AgentModelProvider] = {}

    def register(self, provider: AgentModelProvider) -> None:
        self._providers[provider.name] = provider

    def resolve(self, config: AgentConfig) -> AgentModelProfile:
        return resolve_agent_model(config)

    def create_provider(self, config: AgentConfig) -> LLMProvider:
        profile = self.resolve(config)
        provider = self._providers.get(profile.provider)
        if provider is None:
            raise LLMProviderUnavailable(f"Unsupported agent provider: {profile.provider}")
        return provider.factory(config, profile)

    async def list_available_models(self, config: AgentConfig) -> list[dict]:
        profile = self.resolve(config)
        provider = self._providers.get(profile.provider)
        if provider is None:
            raise LLMProviderUnavailable(f"Unsupported agent provider: {profile.provider}")
        return await provider.list_models(config, profile)


def default_agent_model_registry() -> AgentModelRegistry:
    """Build the built-in provider registry."""
    registry = AgentModelRegistry()

    def build_codex(config: AgentConfig, profile: AgentModelProfile) -> LLMProvider:
        from .providers.codex import CodexProvider

        return CodexProvider(config, profile)

    async def list_codex(config: AgentConfig, profile: AgentModelProfile) -> list[dict]:
        from .providers.codex import CodexProvider

        return await CodexProvider(config, profile).list_models()

    def build_anthropic(config: AgentConfig, profile: AgentModelProfile) -> LLMProvider:
        from .providers.anthropic import AnthropicProvider

        return AnthropicProvider(config, profile)

    async def list_anthropic(config: AgentConfig, profile: AgentModelProfile) -> list[dict]:
        from .providers.anthropic import AnthropicProvider

        return await AnthropicProvider(config, profile).list_models()

    registry.register(AgentModelProvider(CODEX_PROVIDER, build_codex, list_codex))
    registry.register(AgentModelProvider(ANTHROPIC_PROVIDER, build_anthropic, list_anthropic))
    return registry


DEFAULT_AGENT_MODEL_REGISTRY = default_agent_model_registry()
