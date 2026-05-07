"""In-memory runtime state for streaming agent sessions."""
from __future__ import annotations

import asyncio
import uuid
from collections import deque
from dataclasses import dataclass, field
from typing import Any

AGENT_RUN_BUFFER_LIMIT = 240


@dataclass
class AgentRunChannel:
    """Holds the live projection and subscribers for one session run."""

    session_id: str
    run_id: str
    status: str = "running"
    active_flags: list[str] = field(default_factory=list)
    error: str | None = None
    seq: int = 0
    events: deque[dict[str, Any]] = field(default_factory=lambda: deque(maxlen=AGENT_RUN_BUFFER_LIMIT))
    subscribers: set[asyncio.Queue[dict[str, Any] | None]] = field(default_factory=set)
    task: asyncio.Task[None] | None = None

    def payload(self) -> dict[str, Any]:
        """Return the frontend-facing status payload."""
        return {
            "sessionId": self.session_id,
            "runId": self.run_id,
            "status": self.status,
            "activeFlags": list(self.active_flags),
            "lastSeq": self.seq,
            "error": self.error,
        }


class AgentSessionRunRegistry:
    """Tracks agent run lifecycles independently from SSE subscribers."""

    def __init__(self) -> None:
        self._lock = asyncio.Lock()
        self._channels: dict[str, AgentRunChannel] = {}

    async def start(self, session_id: str) -> AgentRunChannel:
        """Start a new run for a session, rejecting overlapping runs."""
        async with self._lock:
            existing = self._channels.get(session_id)
            if existing is not None and existing.status == "running":
                raise ValueError(f"agent session is already running: {session_id}")
            channel = AgentRunChannel(session_id=session_id, run_id=str(uuid.uuid4()))
            self._channels[session_id] = channel
            return channel

    async def attach_task(
        self,
        session_id: str,
        run_id: str,
        task: asyncio.Task[None],
    ) -> None:
        """Attach the background task after it is created."""
        async with self._lock:
            channel = self._channels.get(session_id)
            if channel is not None and channel.run_id == run_id:
                channel.task = task

    async def publish(self, session_id: str, run_id: str, event: dict[str, Any]) -> dict[str, Any]:
        """Publish one event to the session buffer and live subscribers."""
        async with self._lock:
            channel = self._channels.get(session_id)
            if channel is None or channel.run_id != run_id:
                return {}
            channel.seq += 1
            wrapped = {
                "sessionId": session_id,
                "runId": run_id,
                "seq": channel.seq,
                "event": event,
            }
            channel.events.append(wrapped)
            subscribers = list(channel.subscribers)
        for queue in subscribers:
            await queue.put(wrapped)
        return wrapped

    async def finish(
        self,
        session_id: str,
        run_id: str,
        *,
        error: str | None = None,
        interrupted: bool = False,
    ) -> None:
        """Mark a run as idle or failed and close subscriber streams."""
        async with self._lock:
            channel = self._channels.get(session_id)
            if channel is None or channel.run_id != run_id:
                return
            channel.status = "error" if error else "idle"
            channel.error = error
            channel.active_flags = ["interrupted"] if interrupted else []
            subscribers = list(channel.subscribers)
            channel.subscribers.clear()
        for queue in subscribers:
            await queue.put(None)

    async def subscribe(
        self,
        session_id: str,
        run_id: str,
        *,
        after_seq: int = 0,
    ) -> asyncio.Queue[dict[str, Any] | None]:
        """Subscribe to a run and replay buffered events newer than after_seq."""
        queue: asyncio.Queue[dict[str, Any] | None] = asyncio.Queue()
        async with self._lock:
            channel = self._channels.get(session_id)
            if channel is None or channel.run_id != run_id:
                await queue.put(None)
                return queue
            for event in channel.events:
                if int(event.get("seq") or 0) > after_seq:
                    await queue.put(event)
            if channel.status == "running":
                channel.subscribers.add(queue)
            else:
                await queue.put(None)
        return queue

    async def unsubscribe(
        self,
        session_id: str,
        run_id: str,
        queue: asyncio.Queue[dict[str, Any] | None],
    ) -> None:
        """Detach one subscriber without affecting the run task."""
        async with self._lock:
            channel = self._channels.get(session_id)
            if channel is not None and channel.run_id == run_id:
                channel.subscribers.discard(queue)

    async def is_running(self, session_id: str) -> bool:
        """Return true when a session currently has an active run."""
        async with self._lock:
            channel = self._channels.get(session_id)
            return channel is not None and channel.status == "running"

    async def payload_for_session(self, session_id: str) -> dict[str, Any]:
        """Return a status payload, defaulting to idle for untracked sessions."""
        async with self._lock:
            channel = self._channels.get(session_id)
            if channel is not None:
                return channel.payload()
        return {
            "sessionId": session_id,
            "runId": None,
            "status": "idle",
            "activeFlags": [],
            "lastSeq": 0,
            "error": None,
        }

    async def payloads_for_sessions(self, session_ids: list[str]) -> dict[str, dict[str, Any]]:
        """Return run payloads keyed by session id."""
        return {session_id: await self.payload_for_session(session_id) for session_id in session_ids}

    async def shutdown(self) -> None:
        """Cancel all live runs and close their subscriber streams."""
        async with self._lock:
            channels = list(self._channels.values())
        for channel in channels:
            if channel.status == "running" and channel.task is not None:
                channel.task.cancel()
                try:
                    await channel.task
                except asyncio.CancelledError:
                    pass
                await self.finish(
                    channel.session_id,
                    channel.run_id,
                    error="Agent run interrupted by shutdown.",
                    interrupted=True,
                )
