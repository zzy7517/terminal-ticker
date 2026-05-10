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

    async def append_user_message(self, content: str) -> dict[str, Any]:
        """追加一条用户消息并返回其 payload。"""
        message = await asyncio.to_thread(
            self.store.append_message,
            session_id=self.session.id,
            role="user",
            content=content,
        )
        return message.to_payload()

    async def history_for_context(self, *, limit: int = 8) -> tuple[dict[str, Any], ...]:
        """获取最近的对话历史用于上下文构建。"""
        return await asyncio.to_thread(
            self.store.history_for_context,
            self.session.id,
            limit=limit,
        )

    async def append_transcript_message(
        self,
        message: dict[str, Any],
        *,
        context: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        """将一条对话记录消息持久化到会话存储。"""
        stored = await asyncio.to_thread(
            self.store.append_message,
            session_id=self.session.id,
            role=str(message.get("role") or ""),
            content=str(message.get("content") or ""),
            metadata=message.get("metadata") if isinstance(message.get("metadata"), dict) else None,
            context=context,
            error=str(message.get("error")) if message.get("error") else None,
        )
        return stored.to_payload()

    async def append_transcript_messages(
        self,
        messages: list[dict[str, Any]],
        *,
        context: dict[str, Any] | None = None,
    ) -> list[dict[str, Any]]:
        """批量追加多条对话记录消息到会话存储。"""
        stored: list[dict[str, Any]] = []
        for index, message in enumerate(messages):
            stored.append(
                await self.append_transcript_message(
                    message,
                    context=context if index == 0 else None,
                )
            )
        return stored

    async def payload(self) -> dict[str, Any]:
        """返回当前会话及其消息的完整 payload。"""
        payload = await asyncio.to_thread(self.store.session_payload, self.session.id)
        return payload or {"session": None, "messages": []}

    async def history_payload(self, instrument_key: str) -> dict[str, Any]:
        """返回指定标的的所有历史会话列表 payload。"""
        sessions = await asyncio.to_thread(
            self.store.list_sessions,
            instrument_key,
        )
        return {"sessions": [session.to_payload() for session in sessions]}
