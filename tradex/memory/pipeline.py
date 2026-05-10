"""文件用途：tradex 本地记忆写入流水线门面。"""
from __future__ import annotations

import asyncio
from collections.abc import Callable
from pathlib import Path
from typing import Any
import logging

from ..agent.provider import create_llm_provider
from ..agent.session_store import AgentSessionStore
from ..config import AgentConfig
from ..trading import TradeStore
from .paths import ensure_memory_layout
from .policy import MemoryRuntimePolicy
from .state import (
    DEFAULT_MAX_UNUSED_DAYS,
    DEFAULT_PRUNE_BATCH_SIZE,
    MemoryStateStore,
    SOURCE_MANUAL_NOTE,
    SOURCE_TRADE_EVENT,
)
from .write import (
    MemoryFileStorage,
    Phase1Extraction,
    Phase1Processor,
    Phase2Runner,
    normalize_phase1_output,
)

LOGGER = logging.getLogger(__name__)
STAGE1_CONCURRENCY = 4
DEFAULT_PHASE2_HEARTBEAT_MS = 90_000
DEFAULT_STARTUP_SCAN_LIMIT = 5_000
DEFAULT_MAX_SOURCE_AGE_DAYS = 180
DEFAULT_MIN_AGENT_SESSION_IDLE_HOURS = 12
DEFAULT_EXTENSION_RETENTION_DAYS = 7


class MemoryPipeline:
    """说明：后台执行 Phase 1/2，并保持读路径始终可用。

    具体抽取、文件同步和聚合逻辑拆在 `memory.write` 下；这里只负责
    组装依赖、执行顺序和 public API 兼容。
    """

    def __init__(
        self,
        *,
        root: str | Path | None = None,
        state_store: MemoryStateStore | None = None,
        agent_session_store: AgentSessionStore | None = None,
        trade_store: TradeStore | None = None,
        agent_config_provider: Callable[[], AgentConfig | None] | None = None,
        phase2_config_provider: Callable[[], AgentConfig | None] | None = None,
        llm_provider_factory: Callable[[AgentConfig], Any] = create_llm_provider,
        policy: MemoryRuntimePolicy | None = None,
        phase2_heartbeat_interval_ms: int = DEFAULT_PHASE2_HEARTBEAT_MS,
        startup_scan_limit: int = DEFAULT_STARTUP_SCAN_LIMIT,
        max_source_age_days: int = DEFAULT_MAX_SOURCE_AGE_DAYS,
        min_agent_session_idle_hours: int = DEFAULT_MIN_AGENT_SESSION_IDLE_HOURS,
        max_unused_days: int = DEFAULT_MAX_UNUSED_DAYS,
        extension_retention_days: int = DEFAULT_EXTENSION_RETENTION_DAYS,
    ) -> None:
        self.root = ensure_memory_layout(root)
        self.policy = policy or MemoryRuntimePolicy.normal()
        self.state_store = state_store or MemoryStateStore(self.root / "state.sqlite3")
        self.agent_session_store = agent_session_store or AgentSessionStore()
        self.trade_store = trade_store or TradeStore()
        self.agent_config_provider = agent_config_provider
        self.llm_provider_factory = llm_provider_factory
        self.max_unused_days = max(0, int(max_unused_days))
        self._startup_task: asyncio.Task[None] | None = None

        self.storage = MemoryFileStorage(
            root=self.root,
            trade_store=self.trade_store,
            extension_retention_days=extension_retention_days,
        )
        self.phase1 = Phase1Processor(
            root=self.root,
            state_store=self.state_store,
            agent_session_store=self.agent_session_store,
            trade_store=self.trade_store,
            agent_config_provider=self.agent_config_provider,
            llm_provider_factory=self.llm_provider_factory,
            startup_scan_limit=max(1, int(startup_scan_limit)),
            max_source_age_days=max(0, int(max_source_age_days)),
            min_agent_session_idle_hours=max(0, int(min_agent_session_idle_hours)),
        )
        self.phase2 = Phase2Runner(
            root=self.root,
            state_store=self.state_store,
            storage=self.storage,
            agent_config_provider=phase2_config_provider or self.agent_config_provider,
            llm_provider_factory=self.llm_provider_factory,
            heartbeat_interval_ms=phase2_heartbeat_interval_ms,
        )

    def kickoff_startup(self) -> None:
        """说明：异步触发一次启动扫描，不阻塞主流程。"""
        if not self.policy.generate_memories:
            return
        if self._startup_task is not None and not self._startup_task.done():
            return
        self._startup_task = asyncio.create_task(self._run_startup(), name="tradex-memory-startup")

    async def shutdown(self) -> None:
        """说明：停止后台任务，避免测试和重载时遗留悬挂 task。"""
        if self._startup_task is None:
            return
        if not self._startup_task.done():
            self._startup_task.cancel()
            try:
                await self._startup_task
            except asyncio.CancelledError:
                pass
        self._startup_task = None

    async def enqueue_manual_note(
        self,
        *,
        note_id: str,
        payload: str | dict[str, Any],
        updated_at: int | None = None,
    ) -> str:
        """说明：把手动 note 落盘成证据文件，并加入第一阶段队列。"""
        if not self.policy.generate_memories:
            raise RuntimeError("memory generation is disabled for this runtime policy")
        note_key = self.storage.write_manual_note_file(note_id=note_id, payload=payload)
        self.state_store.enqueue_source(
            source_type=SOURCE_MANUAL_NOTE,
            source_ref=note_key,
            updated_at=updated_at,
        )
        return note_key

    def enqueue_trade_event(self, *, trade_id: int, updated_at: int | None = None) -> None:
        """说明：把已关闭交易显式加入 memory Phase 1 队列。"""
        if not self.policy.generate_memories:
            return
        self.state_store.enqueue_source(
            source_type=SOURCE_TRADE_EVENT,
            source_ref=str(int(trade_id)),
            updated_at=updated_at,
        )

    async def run_once(self) -> None:
        """说明：执行一次启动扫描 + Phase 1 + Phase 2。"""
        if not self.policy.generate_memories:
            return
        self.state_store.prune_stage1_outputs_for_retention(
            max_unused_days=self.max_unused_days,
            batch_size=DEFAULT_PRUNE_BATCH_SIZE,
        )
        await self.phase1.scan_startup_sources()
        await self.run_stage1_until_idle()
        await self.run_phase2_once()

    async def run_stage1_until_idle(self, *, batch_size: int = STAGE1_CONCURRENCY) -> None:
        """说明：一直处理到当前没有可领取的第一阶段任务。"""
        if not self.policy.generate_memories:
            return
        while True:
            jobs = self.state_store.claim_stage1_jobs(limit=batch_size)
            if not jobs:
                return
            await asyncio.gather(*(self.phase1.process_job(job) for job in jobs))

    async def run_phase2_once(self, *, limit: int = 100) -> bool:
        """说明：串行执行一次第二阶段聚合；有锁冲突时直接跳过。"""
        if not self.policy.generate_memories:
            return False
        return await self.phase2.run_once(limit=limit)

    def _normalize_phase1_output(self, payload: str | dict[str, Any]) -> Phase1Extraction:
        """说明：兼容旧测试和调试入口，实际实现位于 `memory.write.phase1`。"""
        return normalize_phase1_output(payload)

    async def _run_startup(self) -> None:
        try:
            await self.run_once()
        except asyncio.CancelledError:
            raise
        except Exception:
            LOGGER.exception("memory startup pipeline failed")
