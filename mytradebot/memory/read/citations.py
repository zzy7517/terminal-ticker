"""文件用途：解析 Codex 风格的 memory citation 块。"""
from __future__ import annotations

from dataclasses import dataclass
import re


_CITATION_BLOCK_RE = re.compile(r"<oai-mem-citation>\s*(.*?)\s*</oai-mem-citation>", re.DOTALL)
_SECTION_RE = re.compile(r"<(?P<name>citation_entries|rollout_ids)>\s*(?P<body>.*?)\s*</(?P=name)>", re.DOTALL)
_ENTRY_RE = re.compile(
    r"^(?P<path>[^:\n]+):(?P<start>\d+)-(?P<end>\d+)\|note=\[(?P<note>[^\]\n]*)\]$"
)


@dataclass(frozen=True)
class MemoryCitationEntry:
    """说明：一条 memory 文件引用。"""

    file_path: str
    line_start: int
    line_end: int
    note: str


@dataclass(frozen=True)
class MemoryCitations:
    """说明：一个 `<oai-mem-citation>` 块的解析结果。"""

    entries: tuple[MemoryCitationEntry, ...]
    rollout_ids: tuple[str, ...]


def parse_memory_citations(content: str) -> MemoryCitations | None:
    """说明：解析回答末尾的 Codex 风格 memory citation 块。"""
    matched = _CITATION_BLOCK_RE.search(content or "")
    if not matched:
        return None
    sections = {
        section.group("name"): section.group("body")
        for section in _SECTION_RE.finditer(matched.group(1))
    }
    entries = tuple(
        entry
        for line in sections.get("citation_entries", "").splitlines()
        if (entry := _parse_entry(line.strip())) is not None
    )
    rollout_ids = tuple(
        dict.fromkeys(
            line.strip()
            for line in sections.get("rollout_ids", "").splitlines()
            if _looks_like_uuid(line.strip())
        )
    )
    return MemoryCitations(entries=entries, rollout_ids=rollout_ids)


def _parse_entry(line: str) -> MemoryCitationEntry | None:
    matched = _ENTRY_RE.match(line)
    if not matched:
        return None
    line_start = int(matched.group("start"))
    line_end = int(matched.group("end"))
    if line_end < line_start:
        return None
    return MemoryCitationEntry(
        file_path=matched.group("path").strip(),
        line_start=line_start,
        line_end=line_end,
        note=matched.group("note").strip(),
    )


def _looks_like_uuid(value: str) -> bool:
    return bool(re.fullmatch(
        r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}",
        value,
    ))


__all__ = [
    "MemoryCitationEntry",
    "MemoryCitations",
    "parse_memory_citations",
]
