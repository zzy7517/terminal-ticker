"""Agent runtime primitives inspired by session/runtime style coding agents."""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Callable

from .loop import AgentEventHandler, AgentLLMProvider, AgentLoop, LoopResult
from .tools import AfterToolHook, BeforeToolHook, ToolRegistry, merge_registries


@dataclass(frozen=True)
class ToolPack:
    """A named bundle of tools that can be enabled per runtime."""

    name: str
    factory: Callable[[], ToolRegistry]
    enabled: bool = True

    def build(self) -> ToolRegistry:
        """Build a fresh registry for this tool pack."""
        return self.factory()


@dataclass(frozen=True)
class AgentRuntimeServices:
    """Cross-cutting runtime services shared by all domain runtimes."""

    before_tool_hooks: tuple[BeforeToolHook, ...] = field(default_factory=tuple)
    after_tool_hooks: tuple[AfterToolHook, ...] = field(default_factory=tuple)


class AgentRuntime:
    """Small session runtime that composes provider, prompt, and tool packs."""

    def __init__(
        self,
        *,
        provider: AgentLLMProvider,
        tool_packs: tuple[ToolPack, ...] = tuple(),
        services: AgentRuntimeServices | None = None,
        system_prompt: str | None = None,
        max_iterations: int = 10,
    ) -> None:
        self.provider = provider
        self.tool_packs = tool_packs
        self.services = services or AgentRuntimeServices()
        self.system_prompt = system_prompt
        self.max_iterations = max_iterations

    def build_tools(self) -> ToolRegistry:
        """Build the active tool registry for this runtime turn."""
        registry = merge_registries(
            *(pack.build() for pack in self.tool_packs if pack.enabled)
        )
        registry.extend_hooks(
            before_tool_hooks=self.services.before_tool_hooks,
            after_tool_hooks=self.services.after_tool_hooks,
        )
        return registry

    async def run(
        self,
        *,
        user_message: str,
        conversation_history: list[dict[str, Any]] | None = None,
        event_handler: AgentEventHandler | None = None,
    ) -> LoopResult:
        """Run one model/tool turn using the current runtime composition."""
        loop = AgentLoop(
            provider=self.provider,
            tools=self.build_tools(),
            system_prompt=self.system_prompt,
            max_iterations=self.max_iterations,
        )
        return await loop.run(
            user_message=user_message,
            conversation_history=conversation_history,
            event_handler=event_handler,
        )
