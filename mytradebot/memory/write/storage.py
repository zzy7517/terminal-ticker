"""文件用途：Phase 2 输入文件、事实文件和索引渲染。"""
from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path
from typing import Any
import json

from ...db import now_ms
from ...trading import TradeStore
from ..paths import memory_home
from ..state import SOURCE_AGENT_SESSION, SOURCE_TRADE_EVENT, Stage1Output
from ..validators import validate_fact_text, validate_review_metadata
from .renderers import (
    LEGACY_MANUAL_NOTE_DIRNAME,
    MANUAL_NOTE_DIRNAME,
    MEMORY_INDEX_FILENAME,
    MEMORY_SUMMARY_FILENAME,
    RAW_MEMORIES_FILENAME,
    clean_token,
    exit_fill_kind,
    extract_preference_signals_from_outputs,
    fact_summary_from_markdown,
    filename_timestamp,
    format_number,
    format_timestamp_ms,
    group_outputs,
    keywords_for_output,
    remove_stale_generated_references,
    unique_strings,
)


class MemoryFileStorage:
    """说明：集中管理 memories root 下由 pipeline 生成的文件。"""

    def __init__(
        self,
        *,
        root: Path,
        trade_store: TradeStore,
        extension_retention_days: int,
    ) -> None:
        self.root = root
        self.trade_store = trade_store
        self.extension_retention_days = max(0, int(extension_retention_days))

    def write_manual_note_file(self, *, note_id: str, payload: str | dict[str, Any]) -> str:
        note_key = clean_token(note_id, fallback="note")
        assert note_key is not None
        note_path = self.manual_note_path(note_key)
        note_path.parent.mkdir(parents=True, exist_ok=True)
        serializable = payload if isinstance(payload, dict) else {"text": str(payload)}
        note_path.write_text(json.dumps(serializable, ensure_ascii=False, indent=2))
        return note_key

    def manual_note_path(self, note_ref: str, *, must_exist: bool = False) -> Path:
        path = self.root / MANUAL_NOTE_DIRNAME / f"{note_ref}.json"
        if not must_exist or path.exists():
            return path
        legacy_path = self.root / LEGACY_MANUAL_NOTE_DIRNAME / f"{note_ref}.json"
        return legacy_path if legacy_path.exists() else path

    def sync_rollout_and_memory_files(self, outputs: list[Stage1Output]) -> set[str]:
        expected_paths: set[str] = {RAW_MEMORIES_FILENAME}
        rollout_dir = self.root / "rollout_summaries"
        rollout_dir.mkdir(parents=True, exist_ok=True)
        rendered_rollouts: list[tuple[str, str]] = []
        for output in sorted(outputs, key=lambda item: (item.source.updated_at, item.source_id)):
            relative_path = self.rollout_summary_relative_path(output)
            rendered_rollouts.append((relative_path, self.render_rollout_summary(output)))
            expected_paths.add(relative_path)
        self.prune_generated_files(root=rollout_dir, expected=expected_paths)
        for relative_path, content in rendered_rollouts:
            self.write_relative(relative_path, content)
        self.write_relative(RAW_MEMORIES_FILENAME, self.render_raw_memories(outputs))
        return expected_paths

    def sync_fact_and_review_files(self, outputs: list[Stage1Output]) -> None:
        expected_facts: set[str] = set()
        expected_reviews: set[str] = set()
        for output in outputs:
            if output.source.source_type != SOURCE_TRADE_EVENT:
                continue
            fact_relative = self.trade_fact_relative_path(output)
            if self.managed_trade_fact_was_deleted(output, fact_relative):
                continue
            fact_content = self.render_trade_fact(output)
            validate_fact_text(fact_summary_from_markdown(fact_content))
            self.write_relative(fact_relative, fact_content)
            expected_facts.add(fact_relative)
            review_relative = self.trade_review_relative_path(output)
            review_content = self.render_trade_review(output)
            if review_content is not None:
                self.write_relative(review_relative, review_content)
                expected_reviews.add(review_relative)
        self.prune_generated_files(root=self.root / "facts", expected=expected_facts)
        self.prune_generated_files(root=self.root / "reviews", expected=expected_reviews)

    def render_rollout_summary(self, output: Stage1Output) -> str:
        generated = format_timestamp_ms(output.generated_at)
        return "\n".join([
            f"# Source {output.source_id}: {output.source.source_type}",
            f"generated_at: {generated}",
            f"source_ref: {output.source.source_ref}",
            f"source_updated_at: {format_timestamp_ms(output.source.updated_at)}",
            "",
            "## Rollout Summary",
            output.rollout_summary or "(empty)",
            "",
            "## Raw Memory",
            output.raw_memory or "(empty)",
            "",
        ])

    def render_raw_memories(self, outputs: list[Stage1Output]) -> str:
        lines = ["# Raw Memories", ""]
        for output in sorted(outputs, key=lambda item: item.source_id):
            lines.extend([
                f"## Source {output.source_id}: {output.source.source_type}",
                f"source_ref: {output.source.source_ref}",
                output.raw_memory,
                "",
            ])
        return "\n".join(lines).rstrip() + "\n"

    def render_memory_index(self, outputs: list[Stage1Output]) -> str:
        groups = group_outputs(self.outputs_visible_in_memory(outputs))
        lines: list[str] = []
        for group_name, entries in groups:
            lines.extend([
                f"# Task Group: {group_name}",
                f"scope: {group_name} 的本地记忆索引",
                f"applies_to: cwd={memory_home(self.root).parent}; reuse_rule=优先读 rollout summary，再决定是否继续追查。",
                "",
            ])
            for index, output in enumerate(entries, start=1):
                lines.extend([
                    f"## Task {index}: {output.rollout_summary or output.source.source_ref}",
                    "### rollout_summary_files",
                    f"- {self.rollout_summary_relative_path(output)}",
                ])
                memory_files = self.memory_files_for_output(output)
                if memory_files:
                    lines.append("### memory_files")
                    lines.extend(f"- {path}" for path in memory_files)
                lines.append("### keywords")
                for keyword in keywords_for_output(output):
                    lines.append(f"- {keyword}")
                lines.append("")
            if group_name == "Agent Sessions":
                preferences = extract_preference_signals_from_outputs(entries)
                if preferences:
                    lines.append("## User preferences")
                    for preference in preferences:
                        lines.append(f"- {preference}")
                    lines.append("")
            if group_name == "Closed Trades":
                lines.append("## Reusable knowledge")
                for output in entries:
                    lines.append(f"- {output.rollout_summary}")
                lines.append("")
        return "\n".join(lines).rstrip() + "\n"

    def render_memory_summary(self, outputs: list[Stage1Output]) -> str:
        groups = group_outputs(self.outputs_visible_in_memory(outputs))
        lines = [
            "## User Profile",
            "用户在 mytradebot 里进行本地交易研究、会话记录和交易复盘。",
            "",
            "## User preferences",
        ]
        preferences = extract_preference_signals_from_outputs([
            output for _, group in groups for output in group
            if output.source.source_type == SOURCE_AGENT_SESSION
        ])
        if preferences:
            lines.extend(f"- {item}" for item in preferences)
        else:
            lines.append("- 暂无稳定偏好，必要时回看具体 rollout summary。")
        lines.extend([
            "",
            "## General Tips",
            "- 交易事实只来自已关闭交易和结构化导出，不把复盘假设写成事实。",
            "- 需要细节时先查 MEMORY.md，再按路径打开 rollout_summaries/ 或 facts/。",
            "",
            "## What's in Memory",
        ])
        for group_name, entries in groups:
            lines.append(f"### {group_name}")
            for output in entries:
                lines.append(f"- {format_timestamp_ms(output.generated_at)[:10]}: {output.rollout_summary}")
            lines.append("")
        return "\n".join(lines).rstrip() + "\n"

    def render_trade_fact(self, output: Stage1Output) -> str:
        trade = self.trade_store.get_trade(int(output.source.source_ref))
        if trade is None:
            raise ValueError(f"trade not found: {output.source.source_ref}")
        date = format_timestamp_ms(trade.closed_at_ms or trade.updated_at_ms)[:10]
        summary = (
            f"{trade.instrument_key} {trade.direction.value} trade closed with realized_pnl="
            f"{format_number(trade.realized_pnl)} and exit={exit_fill_kind(trade.fills)}."
        )
        validate_fact_text(summary)
        return "\n".join([
            "---",
            f"id: {self.trade_fact_id(output)}",
            "type: trade_fact",
            f"date: {date}",
            "source_type: trade_store",
            f"source_ref: trade_id={trade.id} snapshot_id={trade.snapshot_id or 'n/a'}",
            "confidence: observed",
            "tags:",
            f"  - {trade.instrument_key}",
            f"  - {trade.direction.value}",
            f"  - {exit_fill_kind(trade.fills)}",
            "---",
            f"事实摘要：{summary}",
            "",
        ])

    def render_trade_review(self, output: Stage1Output) -> str | None:
        trade = self.trade_store.get_trade(int(output.source.source_ref))
        if trade is None:
            raise ValueError(f"trade not found: {output.source.source_ref}")
        lessons = self.trade_store.list_lessons(trade_id=trade.id, limit=20)
        if not lessons:
            return None
        fact_id = self.trade_fact_id(output)
        metadata = {"based_on": [fact_id], "sample_count": len(lessons)}
        validate_review_metadata(metadata)
        date = format_timestamp_ms(trade.closed_at_ms or trade.updated_at_ms)[:10]
        tags = unique_strings(tag for lesson in lessons for tag in lesson.get("tags", []))
        category_lines = unique_strings(str(lesson.get("category") or "") for lesson in lessons)
        lines = [
            "---",
            f"id: {self.trade_review_id(output)}",
            "type: trading_review",
            "status: hypothesis",
            "based_on:",
            f"  - {fact_id}",
            f"sample_count: {len(lessons)}",
            f"date: {date}",
            "source_type: trade_lessons",
            f"source_ref: trade_id={trade.id}",
        ]
        if category_lines:
            lines.append("categories:")
            lines.extend(f"  - {category}" for category in category_lines)
        if tags:
            lines.append("tags:")
            lines.extend(f"  - {tag}" for tag in tags)
        lines.extend(["---", "复盘假设："])
        for lesson in lessons:
            lesson_id = lesson.get("id")
            text = str(lesson.get("text") or "").strip()
            if text:
                lines.append(f"- lesson_id={lesson_id}: {text}")
        lines.append("")
        return "\n".join(lines)

    def rollout_summary_relative_path(self, output: Stage1Output) -> str:
        stamp = filename_timestamp(output.source.updated_at)
        slug = output.rollout_slug or f"{output.source.source_type}-{output.source_id}"
        return f"rollout_summaries/{stamp}-s{output.source_id}-{slug}.md"

    def trade_fact_relative_path(self, output: Stage1Output) -> str:
        trade = self.trade_store.get_trade(int(output.source.source_ref))
        if trade is None:
            raise ValueError(f"trade not found: {output.source.source_ref}")
        closed_at = trade.closed_at_ms or trade.updated_at_ms
        date = datetime.fromtimestamp(closed_at / 1000, tz=timezone.utc)
        slug = output.rollout_slug or f"trade-{trade.id}"
        return f"facts/trading/{date:%Y/%m}/{date:%Y-%m-%d}-s{output.source_id}-{slug}.md"

    def trade_review_relative_path(self, output: Stage1Output) -> str:
        trade = self.trade_store.get_trade(int(output.source.source_ref))
        if trade is None:
            raise ValueError(f"trade not found: {output.source.source_ref}")
        closed_at = trade.closed_at_ms or trade.updated_at_ms
        date = datetime.fromtimestamp(closed_at / 1000, tz=timezone.utc)
        slug = output.rollout_slug or f"trade-{trade.id}"
        return f"reviews/trading/{date:%Y/%m}/{date:%Y-%m-%d}-s{output.source_id}-{slug}-review.md"

    def trade_fact_id(self, output: Stage1Output) -> str:
        return f"fact_trade_s{output.source_id}"

    def trade_review_id(self, output: Stage1Output) -> str:
        return f"review_trade_s{output.source_id}"

    def managed_trade_fact_was_deleted(self, output: Stage1Output, fact_relative: str) -> bool:
        return output.selected_for_phase2 and not (self.root / fact_relative).exists()

    def outputs_visible_in_memory(self, outputs: list[Stage1Output]) -> list[Stage1Output]:
        visible: list[Stage1Output] = []
        for output in outputs:
            if output.source.source_type == SOURCE_TRADE_EVENT:
                try:
                    fact_relative = self.trade_fact_relative_path(output)
                except ValueError:
                    continue
                if not (self.root / fact_relative).exists():
                    continue
            visible.append(output)
        return visible

    def memory_files_for_output(self, output: Stage1Output) -> list[str]:
        if output.source.source_type != SOURCE_TRADE_EVENT:
            return []
        paths: list[str] = []
        fact_relative = self.trade_fact_relative_path(output)
        if (self.root / fact_relative).exists():
            paths.append(fact_relative)
        review_relative = self.trade_review_relative_path(output)
        if (self.root / review_relative).exists():
            paths.append(review_relative)
        return paths

    def sanitize_consolidated_memory_files(self) -> None:
        for relative_path in (MEMORY_INDEX_FILENAME, MEMORY_SUMMARY_FILENAME):
            path = self.root / relative_path
            if not path.exists():
                continue
            original = path.read_text()
            sanitized = remove_stale_generated_references(original, root=self.root)
            if sanitized != original:
                self.write_relative(relative_path, sanitized)

    def write_relative(self, relative_path: str, content: str) -> None:
        path = self.root / relative_path
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content)

    def prune_generated_files(self, *, root: Path, expected: set[str]) -> None:
        if not root.exists():
            return
        for file_path in root.rglob("*.md"):
            relative = file_path.relative_to(self.root).as_posix()
            if relative in expected:
                continue
            if "-s" not in file_path.name:
                continue
            file_path.unlink()

    def prune_old_extension_resources(self) -> None:
        if self.extension_retention_days <= 0:
            return
        cutoff = now_ms() - self.extension_retention_days * 86_400_000
        for relative_dir in (MANUAL_NOTE_DIRNAME, LEGACY_MANUAL_NOTE_DIRNAME):
            root = self.root / relative_dir
            if not root.exists():
                continue
            for file_path in root.rglob("*"):
                if not file_path.is_file():
                    continue
                try:
                    modified_ms = int(file_path.stat().st_mtime * 1000)
                except OSError:
                    continue
                if modified_ms < cutoff:
                    file_path.unlink()
