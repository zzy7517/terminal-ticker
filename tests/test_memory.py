"""测试 Codex 风格的本地记忆读路径。"""
from __future__ import annotations

import asyncio
import json
import os
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from mytradebot.agent.loop import ChatResponse
from mytradebot.agent.session_store import AgentSessionStore
from mytradebot.agent.tools import ToolCall
from mytradebot.agent.trading_runtime import TradingAgentRuntime, TradingAgentRuntimeServices
from mytradebot.config import AgentConfig
from mytradebot.memory import (
    JOB_CLAIMED,
    JOB_FAILED,
    JOB_PENDING,
    JOB_SUCCEEDED,
    JOB_SUCCEEDED_NO_OUTPUT,
    LocalMemoryBackend,
    MemoryAccessError,
    MemoryPipeline,
    MemoryRuntimePolicy,
    MemoryStateStore,
    MemoryValidationError,
    SOURCE_AGENT_SESSION,
    SOURCE_MANUAL_NOTE,
    build_memory_developer_instructions,
    build_memory_tools,
    ensure_memory_layout,
    validate_fact_text,
    validate_review_metadata,
)
from mytradebot.trading import FillKind, TradeDirection, TradeStatus, TradeStore


class MemoryBackendTests(unittest.TestCase):
    """验证记忆文件工具符合 Codex 读路径语义。"""

    def test_list_read_and_reject_unsafe_paths(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            root = Path(tmp_dir)
            (root / "MEMORY.md").write_text("alpha beta\nsolo alpha\nmiddle\nsolo beta\n")
            (root / ".secret").write_text("hidden")
            (root / "rollout_summaries").mkdir()
            (root / "rollout_summaries" / "one.md").write_text("BTCUSDT\n")
            symlink_created = _try_symlink(
                root / "MEMORY.md",
                root / "rollout_summaries" / "linked.md",
            )

            backend = LocalMemoryBackend(root)

            listed = backend.list()
            listed_paths = [entry["path"] for entry in listed["entries"]]
            self.assertEqual(listed["path"], None)
            self.assertIn("MEMORY.md", listed_paths)
            self.assertIn("rollout_summaries", listed_paths)
            self.assertNotIn(".secret", listed_paths)

            read = backend.read(path="MEMORY.md", line_offset=2, max_lines=1)
            self.assertEqual(read["content"], "solo alpha\n")
            self.assertEqual(read["startLineNumber"], 2)
            self.assertTrue(read["truncated"])

            with self.assertRaisesRegex(MemoryAccessError, "memories root"):
                backend.read(path="../MEMORY.md")
            with self.assertRaisesRegex(MemoryAccessError, "was not found"):
                backend.read(path=".secret")
            if symlink_created:
                with self.assertRaisesRegex(MemoryAccessError, "symlink"):
                    backend.read(path="rollout_summaries/linked.md")

    def test_search_match_modes(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            root = Path(tmp_dir)
            (root / "MEMORY.md").write_text(
                "alpha beta\n"
                "solo alpha\n"
                "middle\n"
                "solo beta\n"
                "BTC-USDT setup\n"
            )
            backend = LocalMemoryBackend(root)

            any_match = backend.search(queries=["alpha"], path="MEMORY.md", match_mode="any")
            self.assertEqual([match["matchLineNumber"] for match in any_match["matches"]], [1, 2])

            same_line = backend.search(
                queries=["alpha", "beta"],
                path="MEMORY.md",
                match_mode="all_on_same_line",
            )
            self.assertEqual(len(same_line["matches"]), 1)
            self.assertEqual(same_line["matches"][0]["matchLineNumber"], 1)

            within_lines = backend.search(
                queries=["middle", "beta"],
                path="MEMORY.md",
                match_mode="all_within_lines",
                line_count=2,
                context_lines=0,
            )
            self.assertEqual(len(within_lines["matches"]), 1)
            self.assertEqual(within_lines["matches"][0]["matchLineNumber"], 3)
            self.assertEqual(within_lines["matches"][0]["content"], "middle\nsolo beta")

            normalized = backend.search(
                queries=["btcusdt"],
                path="MEMORY.md",
                normalized=True,
            )
            self.assertEqual(normalized["matches"][0]["matchLineNumber"], 5)

    def test_tool_registry_returns_json_and_marks_errors(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            root = Path(tmp_dir)
            (root / "MEMORY.md").write_text("alpha beta\n")
            registry = build_memory_tools(root)

            result = asyncio.run(registry.execute(ToolCall(
                id="call_1",
                name="read_memory",
                arguments={"path": "MEMORY.md"},
            )))
            payload = json.loads(result.output)

            self.assertFalse(result.error)
            self.assertEqual(payload["path"], "MEMORY.md")
            self.assertEqual(payload["content"], "alpha beta\n")

            unsafe = asyncio.run(registry.execute(ToolCall(
                id="call_2",
                name="read_memory",
                arguments={"path": "../MEMORY.md"},
            )))
            self.assertTrue(unsafe.error)
            self.assertIn("memories root", unsafe.output)

    def test_memory_tools_hide_internal_state_files(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            root = ensure_memory_layout(tmp_dir)
            (root / "MEMORY.md").write_text("alpha beta\n")
            registry = build_memory_tools(root)
            asyncio.run(registry.execute(ToolCall(
                id="usage",
                name="list_memories",
                arguments={},
            )))

            listed = asyncio.run(registry.execute(ToolCall(
                id="list",
                name="list_memories",
                arguments={},
            )))
            payload = json.loads(listed.output)
            listed_paths = {entry["path"] for entry in payload["entries"]}
            self.assertIn("MEMORY.md", listed_paths)
            self.assertNotIn("state.sqlite3", listed_paths)
            self.assertNotIn("state.sqlite3-wal", listed_paths)
            self.assertNotIn("state.sqlite3-shm", listed_paths)

            internal = asyncio.run(registry.execute(ToolCall(
                id="read-state",
                name="read_memory",
                arguments={"path": "state.sqlite3"},
            )))
            self.assertTrue(internal.error)
            self.assertIn("was not found", internal.output)

    def test_prompt_injection_uses_memory_summary(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            root = Path(tmp_dir)
            (root / "memory_summary.md").write_text("User prefers concise answers.")

            instructions = build_memory_developer_instructions(root)

            self.assertIsNotNone(instructions)
            assert instructions is not None
            self.assertIn(str(root), instructions)
            self.assertIn("MEMORY_SUMMARY BEGINS", instructions)
            self.assertIn("User prefers concise answers.", instructions)

    def test_trading_runtime_adds_memory_prompt_and_tools_when_store_exists(self) -> None:
        class CaptureProvider:
            name = "codex"
            model = "capture"

            def __init__(self) -> None:
                self.messages = []
                self.tools = []

            async def chat(self, messages, tools=None, on_delta=None):
                self.messages = messages
                self.tools = tools or []
                return ChatResponse(content="ok")

        with tempfile.TemporaryDirectory() as tmp_dir:
            root = Path(tmp_dir) / "mytradebot" / "memories"
            root.mkdir(parents=True)
            (root / "memory_summary.md").write_text("Remember BTCUSDT breakout reviews.")
            provider = CaptureProvider()
            runtime = TradingAgentRuntime(
                provider=provider,
                config=AgentConfig(model="capture"),
                services=TradingAgentRuntimeServices(
                    context_provider=SimpleNamespace(
                        list_instruments=lambda: tuple(),
                        get_quote=lambda instrument_key: None,
                        get_candles=lambda instrument_key, interval=None: tuple(),
                    ),
                    trade_store=SimpleNamespace(),
                    snapshot_provider=lambda instrument_key: {},
                ),
            )

            with patch.dict(os.environ, {"XDG_DATA_HOME": str(Path(tmp_dir))}, clear=False):
                asyncio.run(runtime.run_turn(
                    session_id="session-1",
                    user_prompt="hello",
                    history=tuple(),
                ))

            tool_names = [tool["function"]["name"] for tool in provider.tools]
            self.assertIn("## Memory", provider.messages[0]["content"])
            self.assertIn("Remember BTCUSDT breakout reviews.", provider.messages[0]["content"])
            self.assertIn("read_memory", tool_names)
            self.assertIn("search_memories", tool_names)

    def test_trading_runtime_skips_memory_prompt_and_tools_when_policy_disables_reads(self) -> None:
        class CaptureProvider:
            name = "codex"
            model = "capture"

            def __init__(self) -> None:
                self.messages = []
                self.tools = []

            async def chat(self, messages, tools=None, on_delta=None):
                self.messages = messages
                self.tools = tools or []
                return ChatResponse(content="ok")

        with tempfile.TemporaryDirectory() as tmp_dir:
            root = Path(tmp_dir) / "mytradebot" / "memories"
            root.mkdir(parents=True)
            (root / "memory_summary.md").write_text("This should not be injected.")
            provider = CaptureProvider()
            runtime = TradingAgentRuntime(
                provider=provider,
                config=AgentConfig(model="capture"),
                services=TradingAgentRuntimeServices(
                    context_provider=SimpleNamespace(
                        list_instruments=lambda: tuple(),
                        get_quote=lambda instrument_key: None,
                        get_candles=lambda instrument_key, interval=None: tuple(),
                    ),
                    trade_store=SimpleNamespace(),
                    snapshot_provider=lambda instrument_key: {},
                    memory_policy=MemoryRuntimePolicy(use_memories=False),
                ),
            )

            with patch.dict(os.environ, {"XDG_DATA_HOME": str(Path(tmp_dir))}, clear=False):
                asyncio.run(runtime.run_turn(
                    session_id="session-1",
                    user_prompt="hello",
                    history=tuple(),
                ))

            tool_names = [tool["function"]["name"] for tool in provider.tools]
            self.assertNotIn("## Memory", provider.messages[0]["content"])
            self.assertNotIn("This should not be injected.", provider.messages[0]["content"])
            self.assertNotIn("read_memory", tool_names)
            self.assertNotIn("search_memories", tool_names)


class MemoryStateTests(unittest.TestCase):
    """验证记忆写入流水线的本地状态机。"""

    def test_layout_creation_and_stage1_success_flow(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            root = ensure_memory_layout(tmp_dir)
            for dirname in ("facts", "reviews", "rollout_summaries", "skills", "evidence"):
                self.assertTrue((root / dirname).is_dir())

            store = MemoryStateStore(root / "state.sqlite3")
            source = store.enqueue_source(
                source_type=SOURCE_AGENT_SESSION,
                source_ref="session-1",
                updated_at=1_000,
            )
            claimed = store.claim_stage1_jobs(limit=1, ownership_token="worker-a")

            self.assertEqual(len(claimed), 1)
            self.assertEqual(claimed[0].source_id, source.id)
            self.assertEqual(claimed[0].status, JOB_CLAIMED)
            self.assertEqual(claimed[0].ownership_token, "worker-a")

            store.mark_stage1_succeeded(
                source_id=source.id,
                raw_memory="### Task 1\nReusable knowledge\n- BTCUSDT reviewed",
                rollout_summary="BTCUSDT session summary",
                rollout_slug="BTCUSDT Review!",
            )
            outputs = store.select_phase2_inputs()
            job = store._stage1_job_for_source_id(store._get_conn(), source.id)

            self.assertEqual(job.status, JOB_SUCCEEDED)
            self.assertEqual(len(outputs), 1)
            self.assertEqual(outputs[0].source.source_ref, "session-1")
            self.assertEqual(outputs[0].rollout_slug, "btcusdt-review")

    def test_source_watermark_only_moves_forward(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            store = MemoryStateStore(Path(tmp_dir) / "state.sqlite3")
            source = store.enqueue_source(
                source_type=SOURCE_MANUAL_NOTE,
                source_ref="note-1",
                updated_at=2_000,
            )
            store.mark_stage1_succeeded(
                source_id=source.id,
                raw_memory="keep",
                rollout_summary="summary",
            )

            same_source = store.enqueue_source(
                source_type=SOURCE_MANUAL_NOTE,
                source_ref="note-1",
                updated_at=1_000,
            )
            claimed = store.claim_stage1_jobs(limit=1)

            self.assertEqual(same_source.updated_at, 2_000)
            self.assertEqual(claimed, [])

    def test_no_output_removes_stale_stage1_output(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            store = MemoryStateStore(Path(tmp_dir) / "state.sqlite3")
            source = store.enqueue_source(
                source_type=SOURCE_AGENT_SESSION,
                source_ref="session-2",
            )
            store.mark_stage1_succeeded(
                source_id=source.id,
                raw_memory="old",
                rollout_summary="old summary",
            )
            source = store.enqueue_source(
                source_type=SOURCE_AGENT_SESSION,
                source_ref="session-2",
                updated_at=source.updated_at + 1,
            )
            store.mark_stage1_succeeded(
                source_id=source.id,
                raw_memory="",
                rollout_summary="",
            )
            job = store._stage1_job_for_source_id(store._get_conn(), source.id)

            self.assertEqual(store.select_phase2_inputs(), [])
            self.assertEqual(job.status, JOB_SUCCEEDED_NO_OUTPUT)

    def test_failed_and_expired_stage1_jobs_can_be_reclaimed(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            store = MemoryStateStore(Path(tmp_dir) / "state.sqlite3")
            failed_source = store.enqueue_source(
                source_type=SOURCE_AGENT_SESSION,
                source_ref="failed",
            )
            expired_source = store.enqueue_source(
                source_type=SOURCE_AGENT_SESSION,
                source_ref="expired",
            )
            store.mark_stage1_failed(source_id=failed_source.id, error="temporary", retry_delay_ms=-1)
            store.claim_stage1_jobs(limit=1, ownership_token="old", lease_ms=-1)

            reclaimed = store.claim_stage1_jobs(limit=2, ownership_token="new")
            reclaimed_refs = {job.source.source_ref for job in reclaimed}

            self.assertEqual(reclaimed_refs, {"failed", "expired"})
            self.assertTrue(all(job.status == JOB_CLAIMED for job in reclaimed))
            self.assertTrue(all(job.ownership_token == "new" for job in reclaimed))

    def test_phase2_lock_and_heartbeat_respect_owner_token(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            store = MemoryStateStore(Path(tmp_dir) / "state.sqlite3")

            claimed = store.claim_phase2(ownership_token="phase2-a")
            blocked = store.claim_phase2(ownership_token="phase2-b")
            wrong_heartbeat = store.heartbeat_phase2(ownership_token="phase2-b")
            right_heartbeat = store.heartbeat_phase2(ownership_token="phase2-a")

            self.assertIsNotNone(claimed)
            self.assertEqual(claimed.status, JOB_CLAIMED)
            self.assertIsNone(blocked)
            self.assertFalse(wrong_heartbeat)
            self.assertTrue(right_heartbeat)

            store.mark_phase2_failed(error="retry", retry_delay_ms=-1)
            retried = store.claim_phase2(ownership_token="phase2-c")
            self.assertIsNotNone(retried)
            self.assertEqual(retried.ownership_token, "phase2-c")

            store.mark_phase2_succeeded(completion_watermark=123)
            final_job = store.get_phase2_job()
            self.assertEqual(final_job.status, JOB_SUCCEEDED)
            self.assertEqual(final_job.completion_watermark, 123)

    def test_phase2_selection_marks_snapshot_and_respects_retention(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            store = MemoryStateStore(Path(tmp_dir) / "state.sqlite3")
            source = store.enqueue_source(
                source_type=SOURCE_MANUAL_NOTE,
                source_ref="old-note",
            )
            store.mark_stage1_succeeded(
                source_id=source.id,
                raw_memory="memory",
                rollout_summary="summary",
            )
            self.assertFalse(store.select_phase2_inputs()[0].selected_for_phase2)

            store.mark_phase2_succeeded(selected_source_ids=[source.id])
            self.assertTrue(store.select_phase2_inputs()[0].selected_for_phase2)

            with store._get_conn() as conn:
                conn.execute(
                    "UPDATE stage1_outputs SET generated_at = 0, last_usage = NULL WHERE source_id = ?",
                    (source.id,),
                )

            self.assertEqual(store.select_phase2_inputs(max_unused_days=1), [])
            retained = store.select_phase2_inputs(max_unused_days=None)
            self.assertEqual(retained[0].source_id, source.id)

    def test_validators_keep_fact_and_review_boundaries(self) -> None:
        validate_fact_text("BTCUSDT 15m long entry stopped out at -0.8R.")
        validate_review_metadata({"based_on": ["fact_20260508_001"], "sample_count": 1})

        with self.assertRaisesRegex(MemoryValidationError, "因为"):
            validate_fact_text("BTCUSDT 止损，因为入场太晚。")
        with self.assertRaisesRegex(MemoryValidationError, "based_on"):
            validate_review_metadata({"sample_count": 1})
        with self.assertRaisesRegex(MemoryValidationError, "sample_count"):
            validate_review_metadata({"based_on": ["fact_1"], "sample_count": 0})

    def test_ephemeral_policy_disables_memory_generation(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            root = ensure_memory_layout(tmp_dir)
            policy = MemoryRuntimePolicy.consolidation()
            pipeline = MemoryPipeline(root=root, policy=policy)

            self.assertTrue(policy.ephemeral)
            self.assertFalse(policy.generate_memories)
            self.assertFalse(policy.use_memories)
            with self.assertRaisesRegex(RuntimeError, "generation is disabled"):
                asyncio.run(pipeline.enqueue_manual_note(
                    note_id="blocked",
                    payload={"text": "should not persist"},
                ))
            asyncio.run(pipeline.run_once())

            self.assertFalse((root / "extensions" / "ad_hoc" / "notes" / "blocked.json").exists())


class MemoryPipelineTests(unittest.TestCase):
    """验证本地 memory pipeline 的端到端行为。"""

    def test_pipeline_exports_closed_trade_manual_note_and_indexes(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            root = ensure_memory_layout(tmp_dir)
            session_store = AgentSessionStore(Path(tmp_dir) / "agent.sqlite3")
            trade_store = TradeStore(Path(tmp_dir) / "trades.sqlite3")
            session = session_store.create_global_session(
                title="Memory Session",
                provider="codex",
                model="gpt-test",
                api_mode="codex_responses",
                reasoning_effort="medium",
            )
            session_store.append_message(
                session_id=session.id,
                role="user",
                content="不要自动提交 git，帮我记住这个偏好。",
            )
            session_store.append_message(
                session_id=session.id,
                role="assistant",
                content="已记录，不会自动提交。",
            )

            snapshot = trade_store.save_snapshot(
                instrument_key="bitget:BTCUSDT:USDT-FUTURES",
                payload={"timeframes": {"15m": [1, 2, 3]}},
            )
            trade = trade_store.create_trade(
                instrument_key="bitget:BTCUSDT:USDT-FUTURES",
                direction=TradeDirection.LONG,
                size=0.25,
                intent_price=62000.0,
                stop_price=61500.0,
                target_prices=(63000.0,),
                reasoning_text="breakout plan",
                session_id=session.id,
                snapshot_id=snapshot.id,
                status=TradeStatus.OPEN,
            )
            trade_store.record_fill(
                trade_id=trade.id,
                kind=FillKind.ENTRY,
                price=62010.0,
                quantity=0.25,
                trigger_reason="entry filled",
            )
            trade_store.record_fill(
                trade_id=trade.id,
                kind=FillKind.STOP,
                price=61500.0,
                quantity=0.25,
                trigger_reason="stop hit",
            )
            trade_store.mark_closed(trade.id, realized_pnl=-127.5)
            trade_store.save_lesson(
                trade_id=trade.id,
                instrument_key=trade.instrument_key,
                category="entry",
                text="Entry was late; treat this as a hypothesis until more samples exist.",
                tags=("late_entry",),
            )

            pipeline = MemoryPipeline(
                root=root,
                agent_session_store=session_store,
                trade_store=trade_store,
                min_agent_session_idle_hours=0,
            )
            asyncio.run(pipeline.enqueue_manual_note(
                note_id="note-1",
                payload={"text": "记住：只把已发生的交易写成事实。"},
            ))
            asyncio.run(pipeline.run_once())

            raw_memories = (root / "raw_memories.md").read_text()
            memory_index = (root / "MEMORY.md").read_text()
            memory_summary = (root / "memory_summary.md").read_text()
            rollout_paths = sorted((root / "rollout_summaries").glob("*.md"))
            fact_paths = sorted((root / "facts").rglob("*.md"))
            review_paths = sorted((root / "reviews").rglob("*.md"))

            self.assertEqual(len(rollout_paths), 3)
            self.assertIn("Closed trade export", raw_memories)
            self.assertIn("Manual note", raw_memories)
            self.assertIn("不要自动提交 git", memory_index)
            self.assertIn("Closed Trades", memory_summary)
            self.assertEqual(len(fact_paths), 1)
            self.assertEqual(len(review_paths), 1)
            fact_content = fact_paths[0].read_text()
            self.assertIn("fact_trade_s", fact_content)
            self.assertNotIn("因为", fact_content)
            self.assertIn("realized_pnl=-127.5", fact_content)
            review_content = review_paths[0].read_text()
            self.assertIn("status: hypothesis", review_content)
            self.assertIn("based_on:", review_content)
            self.assertIn("sample_count: 1", review_content)
            self.assertIn("Entry was late", review_content)
            self.assertIn(fact_paths[0].relative_to(root).as_posix(), memory_index)
            self.assertIn(review_paths[0].relative_to(root).as_posix(), memory_index)

    def test_phase2_respects_deleted_trade_fact_and_removes_index(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            root = ensure_memory_layout(tmp_dir)
            state_store = MemoryStateStore(root / "state.sqlite3")
            trade_store = TradeStore(Path(tmp_dir) / "trades.sqlite3")
            trade = trade_store.create_trade(
                instrument_key="bitget:ETHUSDT:USDT-FUTURES",
                direction=TradeDirection.SHORT,
                size=1.0,
                intent_price=3000.0,
                stop_price=3050.0,
                target_prices=(2900.0,),
                status=TradeStatus.OPEN,
            )
            trade_store.record_fill(
                trade_id=trade.id,
                kind=FillKind.ENTRY,
                price=3000.0,
                quantity=1.0,
            )
            trade_store.record_fill(
                trade_id=trade.id,
                kind=FillKind.TARGET,
                price=2900.0,
                quantity=1.0,
            )
            trade = trade_store.mark_closed(trade.id, realized_pnl=100.0)
            source = state_store.enqueue_source(
                source_type="trade_event",
                source_ref=str(trade.id),
                updated_at=trade.updated_at_ms,
            )
            state_store.mark_stage1_succeeded(
                source_id=source.id,
                raw_memory="### Task 1: Closed trade export",
                rollout_summary="ETHUSDT short trade closed.",
                rollout_slug="ethusdt-target-profit",
            )
            pipeline = MemoryPipeline(root=root, state_store=state_store, trade_store=trade_store)
            asyncio.run(pipeline.run_phase2_once())
            fact_path = next((root / "facts").rglob("*.md"))
            fact_relative = fact_path.relative_to(root).as_posix()
            self.assertIn("ETHUSDT short trade closed", (root / "MEMORY.md").read_text())
            self.assertTrue(state_store.select_phase2_inputs()[0].selected_for_phase2)

            class StaleIndexProvider:
                name = "codex"
                model = "fake-memory"

                async def chat(self, messages, tools=None):
                    return ChatResponse(content=json.dumps({
                        "memory_md": "\n".join([
                            "# Task Group: Closed Trades",
                            "scope: stale trade index",
                            "applies_to: cwd=/tmp; reuse_rule=test",
                            "",
                            "## Task 1: ETHUSDT short trade closed",
                            "### memory_files",
                            f"- {fact_relative}",
                            "### keywords",
                            "- ETHUSDT",
                            "",
                        ]),
                        "memory_summary_md": "## User Profile\nstale\n",
                    }))

            fact_path.unlink()
            state_store.queue_phase2()
            pipeline = MemoryPipeline(
                root=root,
                state_store=state_store,
                trade_store=trade_store,
                agent_config_provider=lambda: AgentConfig(model="fake-memory"),
                llm_provider_factory=lambda _: StaleIndexProvider(),
            )
            asyncio.run(pipeline.run_phase2_once())

            self.assertFalse(fact_path.exists())
            self.assertNotIn("ETHUSDT short trade closed", (root / "MEMORY.md").read_text())

    def test_phase1_output_schema_is_strict(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            pipeline = MemoryPipeline(root=tmp_dir)

            with self.assertRaisesRegex(ValueError, "extra keys"):
                pipeline._normalize_phase1_output({
                    "rollout_summary": "summary",
                    "rollout_slug": None,
                    "raw_memory": "memory",
                    "extra": "not allowed",
                })
            with self.assertRaisesRegex(ValueError, "raw_memory"):
                pipeline._normalize_phase1_output({
                    "rollout_summary": "summary",
                    "rollout_slug": None,
                    "raw_memory": ["not a string"],
                })

    def test_phase1_treats_partial_output_as_no_output(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            root = ensure_memory_layout(tmp_dir)
            pipeline = MemoryPipeline(root=root)
            note_key = asyncio.run(pipeline.enqueue_manual_note(
                note_id="partial-output",
                payload={
                    "rollout_summary": "summary without raw memory",
                    "rollout_slug": "partial-output",
                    "raw_memory": "",
                },
            ))

            asyncio.run(pipeline.run_stage1_until_idle())

            with pipeline.state_store._get_conn() as conn:
                row = conn.execute(
                    "SELECT id FROM memory_sources WHERE source_type = ? AND source_ref = ?",
                    (SOURCE_MANUAL_NOTE, note_key),
                ).fetchone()
                job = pipeline.state_store._stage1_job_for_source_id(conn, int(row["id"]))

            self.assertEqual(pipeline.state_store.select_phase2_inputs(), [])
            self.assertEqual(job.status, JOB_SUCCEEDED_NO_OUTPUT)

    def test_tool_usage_is_persisted_and_affects_phase2_order(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            root = ensure_memory_layout(tmp_dir)
            state_store = MemoryStateStore(root / "state.sqlite3")
            first = state_store.enqueue_source(
                source_type=SOURCE_MANUAL_NOTE,
                source_ref="first",
                updated_at=1_000,
            )
            second = state_store.enqueue_source(
                source_type=SOURCE_MANUAL_NOTE,
                source_ref="second",
                updated_at=2_000,
            )
            state_store.mark_stage1_succeeded(
                source_id=first.id,
                raw_memory="one",
                rollout_summary="first summary",
                rollout_slug="first",
            )
            state_store.mark_stage1_succeeded(
                source_id=second.id,
                raw_memory="two",
                rollout_summary="second summary",
                rollout_slug="second",
            )

            pipeline = MemoryPipeline(root=root, state_store=state_store)
            asyncio.run(pipeline.run_phase2_once())
            rollout_paths = sorted((root / "rollout_summaries").glob("*.md"))
            self.assertEqual(len(rollout_paths), 2)

            registry = build_memory_tools(root)
            first_rollout = next(path for path in rollout_paths if "-s1-" in path.name)
            asyncio.run(registry.execute(ToolCall(
                id="usage-1",
                name="read_memory",
                arguments={"path": f"rollout_summaries/{first_rollout.name}"},
            )))

            ordered = state_store.select_phase2_inputs()
            self.assertEqual(ordered[0].source_id, first.id)
            self.assertGreaterEqual(ordered[0].usage_count, 1)

    def test_kickoff_startup_is_non_blocking(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            pipeline = MemoryPipeline(root=tmp_dir)
            started = asyncio.Event()

            async def slow_startup() -> None:
                started.set()
                await asyncio.sleep(0.2)

            pipeline._run_startup = slow_startup  # type: ignore[method-assign]

            async def scenario() -> None:
                pipeline.kickoff_startup()
                self.assertIsNotNone(pipeline._startup_task)
                assert pipeline._startup_task is not None
                self.assertFalse(pipeline._startup_task.done())
                await started.wait()
                await pipeline.shutdown()

            asyncio.run(scenario())


def _try_symlink(target: Path, link: Path) -> bool:
    try:
        link.symlink_to(target)
    except (OSError, NotImplementedError):
        return False
    return True
