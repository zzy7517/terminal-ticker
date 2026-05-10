"""文件用途：memory 写路径共享的渲染和清洗辅助函数。"""
from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path
from typing import Any
import json
import re

from ...trading import FillKind
from ..state import SOURCE_AGENT_SESSION, SOURCE_MANUAL_NOTE, SOURCE_TRADE_EVENT, Stage1Output

RAW_MEMORIES_FILENAME = "raw_memories.md"
MEMORY_INDEX_FILENAME = "MEMORY.md"
MEMORY_SUMMARY_FILENAME = "memory_summary.md"
MANUAL_NOTE_DIRNAME = "extensions/ad_hoc/notes"
LEGACY_MANUAL_NOTE_DIRNAME = "extensions/manual_notes"


def clean_token(value: Any, *, fallback: str | None) -> str | None:
    if value is None:
        return fallback
    clean = re.sub(r"[^a-zA-Z0-9_-]+", "-", str(value).strip()).strip("-").lower()
    return clean or fallback


def parse_json_object(content: str) -> dict[str, Any]:
    text = strip_json_fence(content).strip()
    parsed = json.loads(text)
    if not isinstance(parsed, dict):
        raise ValueError("LLM memory output must be a JSON object")
    return parsed


def strip_json_fence(content: str) -> str:
    text = content.strip()
    if not text.startswith("```"):
        return text
    text = text.strip("`").strip()
    if "\n" in text and text.split("\n", 1)[0].strip().lower() in {"json", "javascript"}:
        return text.split("\n", 1)[1].strip()
    return text


def json_for_prompt(payload: dict[str, Any], *, limit: int = 120_000) -> str:
    text = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
    text = redact_secrets(text)
    if len(text) <= limit:
        return text
    head = max(1, limit // 2)
    tail = max(1, limit - head - 80)
    return text[:head] + "\n...[memory prompt truncated]...\n" + text[-tail:]


def redact_secrets(text: str) -> str:
    redacted = re.sub(
        r"(?i)(api[_-]?key|secret|token|password|passphrase|authorization|cookie)(\"?\s*[:=]\s*\"?)[^\",}\s]+",
        lambda match: f"{match.group(1)}{match.group(2)}[REDACTED_SECRET]",
        text,
    )
    return re.sub(r"Bearer\s+[A-Za-z0-9._~+/=-]+", "Bearer [REDACTED_SECRET]", redacted)


def read_text_if_exists(path: Path, *, limit: int = 80_000) -> str:
    try:
        content = path.read_text()
    except OSError:
        return ""
    if len(content) <= limit:
        return content
    return content[: limit // 2] + "\n...[file truncated]...\n" + content[-(limit // 2):]


def read_markdown_tree(root: Path, *, file_limit: int = 80, char_limit: int = 120_000) -> list[dict[str, str]]:
    if not root.exists():
        return []
    entries: list[dict[str, str]] = []
    total_chars = 0
    for path in sorted(root.rglob("*.md")):
        if not path.is_file():
            continue
        content = read_text_if_exists(path, limit=20_000)
        if total_chars + len(content) > char_limit:
            break
        entries.append({
            "path": path.relative_to(root.parent).as_posix(),
            "content": content,
        })
        total_chars += len(content)
        if len(entries) >= file_limit:
            break
    return entries


def trade_slug(instrument_key: str, exit_kind: str, realized_pnl: float) -> str:
    symbol = instrument_key.split(":")[-2] if instrument_key.count(":") >= 2 else instrument_key
    direction = "profit" if realized_pnl >= 0 else "loss"
    return clean_token(f"{symbol}-{exit_kind}-{direction}", fallback="trade") or "trade"


def exit_fill_kind(fills: list[Any] | tuple[Any, ...]) -> str:
    for candidate in reversed(list(fills)):
        if getattr(candidate, "kind", None) in (FillKind.STOP, FillKind.TARGET, FillKind.EXIT):
            return candidate.kind.value
    return "closed"


def format_number(value: float) -> str:
    text = f"{float(value):.8f}".rstrip("0").rstrip(".")
    return text or "0"


def format_optional_number(value: float | None) -> str:
    return "n/a" if value is None else format_number(value)


def clip_text(text: str, *, limit: int) -> str:
    content = " ".join(text.split())
    return content if len(content) <= limit else f"{content[:limit - 3]}..."


def extract_preference_signals(messages: list[str]) -> list[str]:
    signals: list[str] = []
    for message in messages:
        compact = " ".join(message.split())
        if any(term in compact for term in ("不要", "别", "不要自动", "先不要")):
            signals.append(clip_text(compact, limit=120))
    return list(dict.fromkeys(signals))


def extract_preference_signals_from_outputs(outputs: list[Stage1Output]) -> list[str]:
    items: list[str] = []
    for output in outputs:
        for line in output.raw_memory.splitlines():
            stripped = line.strip()
            if stripped.startswith("- ") and any(term in stripped for term in ("不要", "别", "prefer", "偏好")):
                items.append(stripped[2:])
    return list(dict.fromkeys(items))


def keywords_for_output(output: Stage1Output) -> list[str]:
    keywords: list[str] = [output.source.source_type]
    if output.source.source_type == SOURCE_TRADE_EVENT:
        keywords.append(f"trade_id={output.source.source_ref}")
    keywords.extend(re.findall(r"[A-Za-z0-9:_-]{4,}", output.rollout_summary))
    cleaned = [item for item in dict.fromkeys(keywords) if item]
    return cleaned[:8]


def group_outputs(outputs: list[Stage1Output]) -> list[tuple[str, list[Stage1Output]]]:
    grouped: dict[str, list[Stage1Output]] = {
        "Agent Sessions": [],
        "Closed Trades": [],
        "Manual Notes": [],
    }
    for output in outputs:
        if output.source.source_type == SOURCE_AGENT_SESSION:
            grouped["Agent Sessions"].append(output)
        elif output.source.source_type == SOURCE_TRADE_EVENT:
            grouped["Closed Trades"].append(output)
        elif output.source.source_type == SOURCE_MANUAL_NOTE:
            grouped["Manual Notes"].append(output)
    return [(name, items) for name, items in grouped.items() if items]


def unique_strings(values: Any) -> list[str]:
    items: list[str] = []
    for value in values:
        text = str(value).strip()
        if text:
            items.append(text)
    return list(dict.fromkeys(items))


_GENERATED_MEMORY_PATH_RE = re.compile(
    r"(?P<path>(?:facts|reviews|rollout_summaries)/[A-Za-z0-9_./:-]+\.md)"
)


def remove_stale_generated_references(content: str, *, root: Path) -> str:
    lines = content.splitlines(keepends=True)
    if not lines:
        return content
    output: list[str] = []
    block: list[str] = []
    block_is_task = False

    def flush() -> None:
        nonlocal block, block_is_task
        if not block:
            return
        block_text = "".join(block)
        if block_is_task and contains_stale_generated_reference(block_text, root=root):
            block = []
            block_is_task = False
            return
        for line in block:
            if contains_stale_generated_reference(line, root=root):
                continue
            output.append(line)
        block = []
        block_is_task = False

    for line in lines:
        if line.startswith("## "):
            flush()
            block_is_task = line.startswith("## Task ")
            block = [line]
            continue
        block.append(line)
    flush()
    result = "".join(output)
    if content.endswith("\n") and result and not result.endswith("\n"):
        result += "\n"
    return result


def contains_stale_generated_reference(text: str, *, root: Path) -> bool:
    for match in _GENERATED_MEMORY_PATH_RE.finditer(text):
        if not (root / match.group("path")).exists():
            return True
    return False


def filename_timestamp(timestamp_ms: int) -> str:
    return datetime.fromtimestamp(timestamp_ms / 1000, tz=timezone.utc).strftime("%Y-%m-%d-%H%M%S")


def format_timestamp_ms(timestamp_ms: int) -> str:
    return datetime.fromtimestamp(timestamp_ms / 1000, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def iso_to_ms(iso_value: str) -> int:
    return int(datetime.fromisoformat(iso_value.replace("Z", "+00:00")).timestamp() * 1000)


def fact_summary_from_markdown(content: str) -> str:
    for line in content.splitlines():
        if line.startswith("事实摘要："):
            return line.removeprefix("事实摘要：").strip()
    return ""
