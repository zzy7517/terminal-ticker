"""文件用途：memory Phase 1 输入扫描与单源抽取。"""
from __future__ import annotations

import asyncio
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any
import json
import logging

from ...agent.session_store import AgentSessionStore
from ...config import AgentConfig
from ...db import now_ms
from ...trading import TradeStatus, TradeStore
from ..state import (
    DEFAULT_RETRY_DELAY_MS,
    MemoryStateStore,
    SOURCE_AGENT_SESSION,
    SOURCE_MANUAL_NOTE,
    SOURCE_TRADE_EVENT,
    Stage1Job,
)
from .renderers import (
    LEGACY_MANUAL_NOTE_DIRNAME,
    MANUAL_NOTE_DIRNAME,
    clean_token,
    clip_text,
    exit_fill_kind,
    extract_preference_signals,
    format_number,
    format_optional_number,
    iso_to_ms,
    json_for_prompt,
    parse_json_object,
    redact_secrets,
    trade_slug,
)

LOGGER = logging.getLogger(__name__)

PHASE1_SYSTEM_PROMPT = """You are the tradex Memory Writing Agent, Phase 1.

Extract high-signal memory from exactly one source. Output strict JSON only:
{"rollout_summary": string, "rollout_slug": string|null, "raw_memory": string}

High-signal memory includes:
1. Stable user preferences and repeated corrections.
2. Reusable workflow knowledge, exact paths, commands, and failure shields.
3. Reliable task maps and long-lived environment facts.
4. Closed-trade facts, while keeping causal review/hypothesis separate.

Rules:
- User messages are stronger evidence than assistant messages.
- No-op is better than low-signal memory: return empty strings when nothing should persist.
- raw_memory should use task blocks with Preference signals, Reusable knowledge, Failures and how to do differently, and References when applicable.
- For trade facts, record only observed fields. Do not write causal language such as because, caused, likely, should, 因为, 导致, 应该, 倾向.
- Do not store secrets. Replace tokens, keys, passwords, cookies, and auth headers with [REDACTED_SECRET].
"""


@dataclass(frozen=True)
class Phase1Extraction:
    """说明：第一阶段标准化后的严格 JSON 输出。"""

    rollout_summary: str
    rollout_slug: str | None
    raw_memory: str


def manual_note_path(root: Path, note_ref: str, *, must_exist: bool = False) -> Path:
    path = root / MANUAL_NOTE_DIRNAME / f"{note_ref}.json"
    if not must_exist or path.exists():
        return path
    legacy_path = root / LEGACY_MANUAL_NOTE_DIRNAME / f"{note_ref}.json"
    return legacy_path if legacy_path.exists() else path


def normalize_phase1_output(payload: str | dict[str, Any]) -> Phase1Extraction:
    """说明：接受 dict 或严格 JSON 字符串，统一成第一阶段输出。"""
    if isinstance(payload, str):
        parsed = json.loads(payload)
    else:
        parsed = payload
    if not isinstance(parsed, dict):
        raise ValueError("phase1 output must be a JSON object")
    expected_keys = {"rollout_summary", "rollout_slug", "raw_memory"}
    extra_keys = set(parsed) - expected_keys
    missing_keys = expected_keys - set(parsed)
    if extra_keys or missing_keys:
        details: list[str] = []
        if missing_keys:
            details.append(f"missing keys: {sorted(missing_keys)}")
        if extra_keys:
            details.append(f"extra keys: {sorted(extra_keys)}")
        raise ValueError("phase1 output must match the strict schema: " + "; ".join(details))
    if not isinstance(parsed["rollout_summary"], str):
        raise ValueError("phase1 rollout_summary must be a string")
    if parsed["rollout_slug"] is not None and not isinstance(parsed["rollout_slug"], str):
        raise ValueError("phase1 rollout_slug must be a string or null")
    if not isinstance(parsed["raw_memory"], str):
        raise ValueError("phase1 raw_memory must be a string")
    rollout_summary = redact_secrets(str(parsed.get("rollout_summary") or "")).strip()
    rollout_slug_raw = parsed.get("rollout_slug")
    rollout_slug = clean_token(rollout_slug_raw, fallback=None) if rollout_slug_raw else None
    raw_memory = redact_secrets(str(parsed.get("raw_memory") or "")).strip()
    return Phase1Extraction(
        rollout_summary=rollout_summary,
        rollout_slug=rollout_slug,
        raw_memory=raw_memory,
    )


class Phase1Processor:
    """说明：负责把三类 source 提取为 stage1_outputs。"""

    def __init__(
        self,
        *,
        root: Path,
        state_store: MemoryStateStore,
        agent_session_store: AgentSessionStore,
        trade_store: TradeStore,
        agent_config_provider: Callable[[], AgentConfig | None] | None,
        llm_provider_factory: Callable[[AgentConfig], Any],
        startup_scan_limit: int,
        max_source_age_days: int,
        min_agent_session_idle_hours: int,
    ) -> None:
        self.root = root
        self.state_store = state_store
        self.agent_session_store = agent_session_store
        self.trade_store = trade_store
        self.agent_config_provider = agent_config_provider
        self.llm_provider_factory = llm_provider_factory
        self.startup_scan_limit = startup_scan_limit
        self.max_source_age_days = max_source_age_days
        self.min_agent_session_idle_hours = min_agent_session_idle_hours

    async def scan_startup_sources(self) -> None:
        """说明：启动时把会话和已关闭交易补入状态库。"""
        now = now_ms()
        max_age_ms = self.max_source_age_days * 86_400_000
        cutoff = now - max_age_ms if max_age_ms else None
        min_session_idle_ms = self.min_agent_session_idle_hours * 3_600_000

        sessions = await asyncio.to_thread(
            self.agent_session_store.list_all_sessions,
            limit=self.startup_scan_limit,
        )
        for summary in sessions:
            updated_at = iso_to_ms(summary.session.updated_at)
            if cutoff is not None and updated_at < cutoff:
                continue
            if min_session_idle_ms and now - updated_at < min_session_idle_ms:
                continue
            if summary.message_count <= 0:
                continue
            self.state_store.enqueue_source(
                source_type=SOURCE_AGENT_SESSION,
                source_ref=summary.session.id,
                updated_at=updated_at,
            )
        closed = await asyncio.to_thread(
            self.trade_store.list_trades,
            statuses=[TradeStatus.CLOSED],
            limit=self.startup_scan_limit,
        )
        for trade in closed:
            if cutoff is not None and trade.updated_at_ms < cutoff:
                continue
            self.state_store.enqueue_source(
                source_type=SOURCE_TRADE_EVENT,
                source_ref=str(trade.id),
                updated_at=trade.updated_at_ms,
            )

    async def process_job(self, job: Stage1Job) -> None:
        try:
            agent_config = self._current_agent_config()
            if self.agent_config_provider is not None:
                if agent_config is None or not agent_config.enabled:
                    raise RuntimeError("memory Phase 1 requires an enabled agent model configuration")
                payload = await self._serialize_source_for_llm(job)
                extraction = await self._extract_with_llm(
                    job=job,
                    payload=payload,
                    agent_config=agent_config,
                )
            else:
                payload = await self._serialize_source(job)
                extraction = normalize_phase1_output(payload)
            if not extraction.raw_memory.strip() or not extraction.rollout_summary.strip():
                self.state_store.mark_stage1_no_output(source_id=job.source_id)
                return
            self.state_store.mark_stage1_succeeded(
                source_id=job.source_id,
                raw_memory=extraction.raw_memory,
                rollout_summary=extraction.rollout_summary,
                rollout_slug=extraction.rollout_slug,
            )
        except Exception as exc:
            LOGGER.exception("memory phase1 failed for %s:%s", job.source.source_type, job.source.source_ref)
            self.state_store.mark_stage1_failed(
                source_id=job.source_id,
                error=str(exc),
                retry_delay_ms=DEFAULT_RETRY_DELAY_MS,
            )

    def _current_agent_config(self) -> AgentConfig | None:
        if self.agent_config_provider is None:
            return None
        return self.agent_config_provider()

    async def _extract_with_llm(
        self,
        *,
        job: Stage1Job,
        payload: dict[str, Any],
        agent_config: AgentConfig,
    ) -> Phase1Extraction:
        provider = self.llm_provider_factory(agent_config)
        user_payload = {
            "source_id": job.source_id,
            "source_type": job.source.source_type,
            "source_ref": job.source.source_ref,
            "source_updated_at": job.source.updated_at,
            "payload": payload,
        }
        response = await provider.chat(
            messages=[
                {"role": "system", "content": PHASE1_SYSTEM_PROMPT},
                {"role": "user", "content": json_for_prompt(user_payload)},
            ],
            tools=None,
        )
        return normalize_phase1_output(parse_json_object(response.content or ""))

    async def _serialize_source_for_llm(self, job: Stage1Job) -> dict[str, Any]:
        source = job.source
        if source.source_type == SOURCE_AGENT_SESSION:
            return await asyncio.to_thread(self._agent_session_llm_payload, source.source_ref)
        if source.source_type == SOURCE_TRADE_EVENT:
            return await asyncio.to_thread(self._trade_event_llm_payload, source.source_ref)
        if source.source_type == SOURCE_MANUAL_NOTE:
            return await asyncio.to_thread(self._manual_note_llm_payload, source.source_ref)
        raise ValueError(f"unsupported memory source_type: {source.source_type}")

    async def _serialize_source(self, job: Stage1Job) -> str | dict[str, Any]:
        source = job.source
        if source.source_type == SOURCE_AGENT_SESSION:
            return await asyncio.to_thread(self._extract_agent_session, source.source_ref)
        if source.source_type == SOURCE_TRADE_EVENT:
            return await asyncio.to_thread(self._extract_trade_event, source.source_ref)
        if source.source_type == SOURCE_MANUAL_NOTE:
            return await asyncio.to_thread(self._extract_manual_note, source.source_ref)
        raise ValueError(f"unsupported memory source_type: {source.source_type}")

    def _agent_session_llm_payload(self, session_id: str) -> dict[str, Any]:
        payload = self.agent_session_store.session_payload(session_id)
        if not payload:
            raise ValueError(f"agent session not found: {session_id}")
        session = payload.get("session") if isinstance(payload, dict) else None
        messages = payload.get("messages") if isinstance(payload, dict) else None
        filtered_messages: list[dict[str, Any]] = []
        for item in messages or []:
            if not isinstance(item, dict):
                continue
            role = str(item.get("role") or "")
            if role not in {"user", "assistant", "tool"}:
                continue
            filtered_messages.append({
                "role": role,
                "content": str(item.get("content") or ""),
                "created_at": item.get("createdAt") or item.get("created_at"),
                "error": item.get("error"),
            })
        return {
            "session": session,
            "messages": filtered_messages,
        }

    def _trade_event_llm_payload(self, trade_ref: str) -> dict[str, Any]:
        trade = self.trade_store.get_trade(int(trade_ref))
        if trade is None:
            raise ValueError(f"trade not found: {trade_ref}")
        snapshot = self.trade_store.get_snapshot(trade.snapshot_id) if trade.snapshot_id else None
        return {
            "trade": trade.to_payload(),
            "snapshot": snapshot.to_payload() if snapshot is not None else None,
            "fills": [fill.to_payload() for fill in trade.fills],
        }

    def _manual_note_llm_payload(self, note_ref: str) -> dict[str, Any]:
        note_path = manual_note_path(self.root, note_ref, must_exist=True)
        if not note_path.exists():
            raise ValueError(f"manual note not found: {note_ref}")
        return json.loads(note_path.read_text())

    def _extract_agent_session(self, session_id: str) -> dict[str, Any]:
        payload = self.agent_session_store.session_payload(session_id)
        if not payload:
            raise ValueError(f"agent session not found: {session_id}")
        messages = payload.get("messages") or []
        user_messages = [
            str(item.get("content") or "").strip()
            for item in messages
            if item.get("role") == "user" and str(item.get("content") or "").strip()
        ]
        assistant_messages = [
            str(item.get("content") or "").strip()
            for item in messages
            if item.get("role") == "assistant" and str(item.get("content") or "").strip()
        ]
        if not user_messages and not assistant_messages:
            return {"rollout_summary": "", "rollout_slug": None, "raw_memory": ""}
        first_user = user_messages[0] if user_messages else "用户未留下可用输入"
        latest_assistant = assistant_messages[-1] if assistant_messages else ""
        preview = clip_text(first_user, limit=80)
        summary = f"Agent session {session_id} 记录了用户请求：{preview}。"
        if latest_assistant:
            summary += f" 最后一次助手响应为：{clip_text(latest_assistant, limit=80)}。"
        raw_lines = [
            "### Task 1: Agent session transcript",
            "task_outcome: observed",
            "Preference signals:",
        ]
        preference_signals = extract_preference_signals(user_messages)
        if preference_signals:
            raw_lines.extend(f"- {item}" for item in preference_signals)
        else:
            raw_lines.append("- 暂无稳定偏好，仅保留会话请求。")
        raw_lines.extend([
            "Reusable knowledge:",
            f"- 首条用户请求：{preview}",
        ])
        if latest_assistant:
            raw_lines.append(f"- 最近助手输出：{clip_text(latest_assistant, limit=120)}")
        raw_lines.extend([
            "References:",
            f"- session_id={session_id}",
            f"- message_count={len(messages)}",
        ])
        return {
            "rollout_summary": summary,
            "rollout_slug": f"agent-session-{session_id[:8]}",
            "raw_memory": "\n".join(raw_lines),
        }

    def _extract_trade_event(self, trade_ref: str) -> dict[str, Any]:
        trade = self.trade_store.get_trade(int(trade_ref))
        if trade is None:
            raise ValueError(f"trade not found: {trade_ref}")
        if trade.status is not TradeStatus.CLOSED:
            return {"rollout_summary": "", "rollout_slug": None, "raw_memory": ""}
        snapshot = self.trade_store.get_snapshot(trade.snapshot_id) if trade.snapshot_id else None
        fills = list(trade.fills)
        exit_kind = exit_fill_kind(fills)
        pnl_text = format_number(trade.realized_pnl)
        summary = (
            f"{trade.instrument_key} {trade.direction.value} trade closed. "
            f"realized_pnl={pnl_text}, exit={exit_kind}, size={format_number(trade.size)}."
        )
        raw_lines = [
            "### Task 1: Closed trade export",
            "task_outcome: observed",
            "Reusable knowledge:",
            f"- instrument_key={trade.instrument_key}",
            f"- direction={trade.direction.value}",
            f"- status={trade.status.value}",
            f"- size={format_number(trade.size)}",
            f"- realized_pnl={pnl_text}",
            f"- fill_count={len(fills)}",
            f"- average_entry_price={format_optional_number(trade.average_entry_price)}",
            f"- average_exit_price={format_optional_number(trade.average_exit_price)}",
        ]
        if trade.intent_price is not None:
            raw_lines.append(f"- intent_price={format_number(trade.intent_price)}")
        if trade.stop_price is not None:
            raw_lines.append(f"- stop_price={format_number(trade.stop_price)}")
        if trade.target_prices:
            raw_lines.append(
                "- target_prices=" + ",".join(format_number(price) for price in trade.target_prices)
            )
        if fills:
            raw_lines.append("- fills:")
            for fill in fills:
                raw_lines.append(
                    "  - "
                    f"{fill.kind.value}@{format_number(fill.price)} x {format_number(fill.quantity)} "
                    f"reason={fill.trigger_reason or 'n/a'}"
                )
        if snapshot is not None:
            raw_lines.append(f"- snapshot_id={snapshot.id}")
        raw_lines.extend([
            "References:",
            f"- trade_id={trade.id}",
            f"- session_id={trade.session_id or 'n/a'}",
            f"- snapshot_id={trade.snapshot_id or 'n/a'}",
        ])
        return {
            "rollout_summary": summary,
            "rollout_slug": trade_slug(trade.instrument_key, exit_kind, trade.realized_pnl),
            "raw_memory": "\n".join(raw_lines),
        }

    def _extract_manual_note(self, note_ref: str) -> str | dict[str, Any]:
        note_path = manual_note_path(self.root, note_ref, must_exist=True)
        if not note_path.exists():
            raise ValueError(f"manual note not found: {note_ref}")
        payload = json.loads(note_path.read_text())
        if all(key in payload for key in ("rollout_summary", "rollout_slug", "raw_memory")):
            return {
                "rollout_summary": payload.get("rollout_summary"),
                "rollout_slug": payload.get("rollout_slug"),
                "raw_memory": payload.get("raw_memory"),
            }
        text = str(payload.get("text") or payload.get("note") or "").strip()
        if not text:
            return {"rollout_summary": "", "rollout_slug": None, "raw_memory": ""}
        return {
            "rollout_summary": clip_text(text, limit=140),
            "rollout_slug": note_ref,
            "raw_memory": "\n".join([
                "### Task 1: Manual note",
                "task_outcome: observed",
                "Reusable knowledge:",
                f"- {text}",
                "References:",
                f"- manual_note={note_ref}",
            ]),
        }
