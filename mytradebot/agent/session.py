"""Runtime wrapper around persisted agent sessions."""
from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from typing import Any

from ..config import AgentConfig
from .loop import AgentLLMProvider
from .runtime import AgentRuntimeServices
from .session_store import AgentSession, AgentSessionStore


@dataclass
class AgentSessionRuntime:
    """A live agent session with provider, config, and runtime services."""

    session: AgentSession
    store: AgentSessionStore
    config: AgentConfig
    provider: AgentLLMProvider
    runtime_services: AgentRuntimeServices = field(default_factory=AgentRuntimeServices)

    @classmethod
    async def get_or_create_active(
        cls,
        *,
        store: AgentSessionStore,
        instrument_key: str,
        title: str,
        config: AgentConfig,
        provider: AgentLLMProvider,
        runtime_services: AgentRuntimeServices | None = None,
    ) -> "AgentSessionRuntime":
        session = await asyncio.to_thread(
            store.get_or_create_active_session,
            instrument_key=instrument_key,
            title=title,
            provider=config.provider,
            model=config.model,
            api_mode=config.api_mode,
            reasoning_effort=config.reasoning_effort,
        )
        return cls(
            session=session,
            store=store,
            config=config,
            provider=provider,
            runtime_services=runtime_services or AgentRuntimeServices(),
        )

    async def append_user_message(self, content: str) -> None:
        await asyncio.to_thread(
            self.store.append_message,
            session_id=self.session.id,
            role="user",
            content=content,
        )

    async def history_for_context(self, *, limit: int = 8) -> tuple[dict[str, Any], ...]:
        return await asyncio.to_thread(
            self.store.history_for_context,
            self.session.id,
            limit=limit,
        )

    async def record_assistant_analysis(
        self,
        analysis_payload: dict[str, Any],
        *,
        context: dict[str, Any] | None = None,
    ) -> None:
        loop_result = analysis_payload.get("loopResult")
        loop_content = loop_result.get("content") if isinstance(loop_result, dict) else None
        content = str(
            analysis_payload.get("displayText")
            or analysis_payload.get("summary")
            or analysis_payload.get("error")
            or loop_content
            or "Agent response unavailable."
        )
        await asyncio.to_thread(
            self.store.append_message,
            session_id=self.session.id,
            role="assistant",
            content=content,
            analysis=analysis_payload,
            context=context,
            error=analysis_payload.get("error") if not analysis_payload.get("available") else None,
        )

    async def payload(self) -> dict[str, Any]:
        payload = await asyncio.to_thread(self.store.session_payload, self.session.id)
        return payload or {"session": None, "messages": []}

    async def history_payload(self, instrument_key: str) -> dict[str, Any]:
        sessions = await asyncio.to_thread(
            self.store.list_sessions,
            instrument_key,
        )
        return {"sessions": [session.to_payload() for session in sessions]}
