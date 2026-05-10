"""文件用途：memory Phase 2 全局聚合编排。"""
from __future__ import annotations

import asyncio
from collections.abc import Callable
from pathlib import Path
from typing import Any
import logging

from ...config import AgentConfig
from ...db import now_ms
from ..policy import MemoryRuntimePolicy
from ..state import DEFAULT_RETRY_DELAY_MS, MemoryStateStore, Stage1Output
from ..workspace import (
    PHASE2_DIFF_FILENAME,
    MemoryWorkspaceDiff,
    memory_workspace_diff,
    prepare_memory_workspace,
    reset_memory_workspace_baseline,
    write_workspace_diff,
)
from .renderers import (
    MEMORY_INDEX_FILENAME,
    MEMORY_SUMMARY_FILENAME,
    RAW_MEMORIES_FILENAME,
    json_for_prompt,
    parse_json_object,
    read_markdown_tree,
    read_text_if_exists,
    redact_secrets,
)
from .storage import MemoryFileStorage

LOGGER = logging.getLogger(__name__)

PHASE2_SYSTEM_PROMPT = """You are the tradex Memory Writing Agent, Phase 2 (Consolidation).

Consolidate raw_memories.md and rollout_summaries into progressive-disclosure memory files.
Output strict JSON only:
{"memory_md": string, "memory_summary_md": string}

You are running as an internal restricted worker: no tools, no network, no recursive memory reads or writes.
The only writable outputs are the two JSON string fields requested above.

MEMORY.md format:
# Task Group: <cwd / project / workflow>
scope: <what this block covers>
applies_to: cwd=<path-or-scope>; reuse_rule=<when safe to reuse>

## Task 1: <description, outcome>
### rollout_summary_files
- rollout_summaries/... (source metadata if known)
### keywords
- keyword1, keyword2, keyword3

Then include ## User preferences, ## Reusable knowledge, and ## Failures and how to do differently when meaningful.

memory_summary.md format:
## User Profile
## User preferences
## General Tips
## What's in Memory

Rules:
- Read the workspace diff first conceptually; changed raw/rollout inputs are the update queue.
- Preserve provenance and searchable wording.
- Keep facts and reviews separate: facts are observed only; reviews/hypotheses must be labeled as hypotheses.
- Remove stale references when inputs were deleted.
- Do not invent facts, claims, files, or validation.
"""


class Phase2Runner:
    """说明：串行领取全局锁，整理文件，再刷新 workspace baseline。"""

    def __init__(
        self,
        *,
        root: Path,
        state_store: MemoryStateStore,
        storage: MemoryFileStorage,
        agent_config_provider: Callable[[], AgentConfig | None] | None,
        llm_provider_factory: Callable[[AgentConfig], Any],
        heartbeat_interval_ms: int,
    ) -> None:
        self.root = root
        self.state_store = state_store
        self.storage = storage
        self.agent_config_provider = agent_config_provider
        self.llm_provider_factory = llm_provider_factory
        self.heartbeat_interval_ms = max(1, int(heartbeat_interval_ms))
        self.worker_policy = MemoryRuntimePolicy.consolidation()

    async def run_once(self, *, limit: int = 100) -> bool:
        claim = self.state_store.claim_phase2()
        if claim is None:
            return False
        try:
            await prepare_memory_workspace(self.root)
            selected = self.state_store.select_phase2_inputs(limit=limit)
            selected_source_ids = [item.source_id for item in selected]
            self.storage.sync_fact_and_review_files(selected)
            visible_outputs = self.storage.outputs_visible_in_memory(selected)
            self.storage.sync_rollout_and_memory_files(visible_outputs)
            self.storage.prune_old_extension_resources()
            diff = await memory_workspace_diff(self.root)
            if not diff.has_changes:
                self.state_store.mark_phase2_succeeded(selected_source_ids=selected_source_ids)
                return False
            await write_workspace_diff(self.root, diff)
            await self._run_with_heartbeat(
                self._run_consolidation(visible_outputs, diff),
                ownership_token=claim.ownership_token,
            )
            await reset_memory_workspace_baseline(self.root)
            completion_watermark = max((item.generated_at for item in selected), default=now_ms())
            self.state_store.mark_phase2_succeeded(
                completion_watermark=completion_watermark,
                selected_source_ids=selected_source_ids,
            )
            return True
        except Exception as exc:
            LOGGER.exception("memory phase2 failed")
            self.state_store.mark_phase2_failed(error=str(exc), retry_delay_ms=DEFAULT_RETRY_DELAY_MS)
            return False

    async def _run_with_heartbeat(
        self,
        awaitable: Any,
        *,
        ownership_token: str | None,
    ) -> None:
        if ownership_token is None:
            await awaitable
            return
        task = asyncio.create_task(awaitable)
        try:
            while True:
                done, _ = await asyncio.wait(
                    {task},
                    timeout=self.heartbeat_interval_ms / 1000,
                )
                if done:
                    await task
                    return
                if not self.state_store.heartbeat_phase2(ownership_token=ownership_token):
                    task.cancel()
                    try:
                        await task
                    except asyncio.CancelledError:
                        pass
                    raise RuntimeError("memory Phase 2 lost its ownership lease")
        finally:
            if not task.done():
                task.cancel()

    async def _run_consolidation(
        self,
        outputs: list[Stage1Output],
        diff: MemoryWorkspaceDiff,
    ) -> None:
        agent_config = self._current_agent_config()
        if self.agent_config_provider is not None:
            if agent_config is None or not agent_config.enabled:
                raise RuntimeError("memory Phase 2 requires an enabled agent model configuration")
            provider = self.llm_provider_factory(agent_config)
            payload = self._consolidation_prompt_payload(outputs, diff)
            response = await provider.chat(
                messages=[
                    {"role": "system", "content": PHASE2_SYSTEM_PROMPT},
                    {"role": "user", "content": json_for_prompt(payload, limit=180_000)},
                ],
                tools=None,
            )
            parsed = parse_json_object(response.content or "")
            expected_keys = {"memory_md", "memory_summary_md"}
            if set(parsed) != expected_keys:
                raise ValueError("phase2 output must match the strict schema")
            if not isinstance(parsed["memory_md"], str) or not isinstance(parsed["memory_summary_md"], str):
                raise ValueError("phase2 output fields must be strings")
            memory_md = redact_secrets(parsed["memory_md"]).strip()
            memory_summary_md = redact_secrets(parsed["memory_summary_md"]).strip()
            if not memory_md or not memory_summary_md:
                raise ValueError("phase2 consolidation output must include memory_md and memory_summary_md")
            self.storage.write_relative(MEMORY_INDEX_FILENAME, memory_md.rstrip() + "\n")
            self.storage.write_relative(MEMORY_SUMMARY_FILENAME, memory_summary_md.rstrip() + "\n")
            self.storage.sanitize_consolidated_memory_files()
            return

        # 无运行时模型配置的测试/本地 smoke 场景使用确定性整理器；正式应用会注入 AgentConfig。
        self.storage.write_relative(MEMORY_INDEX_FILENAME, self.storage.render_memory_index(outputs))
        self.storage.write_relative(MEMORY_SUMMARY_FILENAME, self.storage.render_memory_summary(outputs))
        self.storage.sanitize_consolidated_memory_files()

    def _current_agent_config(self) -> AgentConfig | None:
        if self.agent_config_provider is None:
            return None
        return self.agent_config_provider()

    def _consolidation_prompt_payload(
        self,
        outputs: list[Stage1Output],
        diff: MemoryWorkspaceDiff,
    ) -> dict[str, Any]:
        # 这只是应用层防递归策略，不是 Codex 的 OS/进程级沙箱。
        return {
            "memory_root": self.root.as_posix(),
            "worker_policy": {
                "ephemeral": self.worker_policy.ephemeral,
                "generate_memories": self.worker_policy.generate_memories,
                "use_memories": self.worker_policy.use_memories,
            },
            "workspace_diff": {
                "changes": [
                    {"status": change.status, "path": change.path}
                    for change in diff.changes
                ],
                "unified_diff": diff.unified_diff,
                "diff_file": PHASE2_DIFF_FILENAME,
                "diff_file_content": read_text_if_exists(self.root / PHASE2_DIFF_FILENAME),
            },
            "existing_memory_md": read_text_if_exists(self.root / MEMORY_INDEX_FILENAME),
            "existing_memory_summary_md": read_text_if_exists(self.root / MEMORY_SUMMARY_FILENAME),
            "raw_memories_md": read_text_if_exists(self.root / RAW_MEMORIES_FILENAME),
            "rollout_summaries": read_markdown_tree(self.root / "rollout_summaries"),
            "facts": read_markdown_tree(self.root / "facts"),
            "reviews": read_markdown_tree(self.root / "reviews"),
            "selected_sources": [
                {
                    "source_id": output.source_id,
                    "source_type": output.source.source_type,
                    "source_ref": output.source.source_ref,
                    "generated_at": output.generated_at,
                    "rollout_summary_file": self.storage.rollout_summary_relative_path(output),
                    "usage_count": output.usage_count,
                    "last_usage": output.last_usage,
                }
                for output in outputs
            ],
        }
