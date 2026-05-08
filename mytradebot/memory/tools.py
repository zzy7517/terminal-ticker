"""文件用途：把本地记忆读路径注册成 Agent 工具。"""
from __future__ import annotations

from pathlib import Path
from typing import Any
import json

from ..agent.tools import ToolDefinition, ToolRegistry
from .backend import (
    DEFAULT_LIST_MAX_RESULTS,
    DEFAULT_READ_MAX_TOKENS,
    DEFAULT_SEARCH_MAX_RESULTS,
    LocalMemoryBackend,
    MemoryAccessError,
)
from .state import MemoryStateStore


def build_memory_tools(memory_root: str | Path | None = None) -> ToolRegistry:
    """说明：基于本地 memories 目录构建只读记忆工具。"""
    registry = ToolRegistry()
    backend = LocalMemoryBackend(memory_root)
    state_store = MemoryStateStore(backend.root / "state.sqlite3")

    def _record_usage(path: str | None, usage_kind: str) -> None:
        target = (path or ".").strip() or "."
        state_store.record_usage(file_path=target, usage_kind=usage_kind)

    async def list_memories(
        path: str | None = None,
        cursor: str | None = None,
        max_results: int = DEFAULT_LIST_MAX_RESULTS,
    ) -> str:
        payload = backend.list(
            path=path,
            cursor=cursor,
            max_results=max_results,
        )
        _record_usage(path, "list")
        return _tool_output(payload)

    registry.register(ToolDefinition(
        name="list_memories",
        description=(
            "List files and directories under the local memory root. "
            "Paths are relative to the memory root; hidden files and symlinks are not visible."
        ),
        parameters={
            "type": "object",
            "properties": {
                "path": {"type": ["string", "null"], "description": "Optional relative directory or file path."},
                "cursor": {"type": ["string", "null"], "description": "Pagination cursor returned by a prior call."},
                "max_results": {"type": "integer", "default": DEFAULT_LIST_MAX_RESULTS, "minimum": 1, "maximum": DEFAULT_LIST_MAX_RESULTS},
            },
        },
        handler=list_memories,
    ))

    async def read_memory(
        path: str,
        line_offset: int = 1,
        max_lines: int | None = None,
        max_tokens: int = DEFAULT_READ_MAX_TOKENS,
    ) -> str:
        payload = backend.read(
            path=path,
            line_offset=line_offset,
            max_lines=max_lines,
            max_tokens=max_tokens,
        )
        _record_usage(path, "read")
        return _tool_output(payload)

    registry.register(ToolDefinition(
        name="read_memory",
        description=(
            "Read a UTF-8 memory file by relative path. "
            "Use 1-indexed line_offset and max_lines to keep reads focused."
        ),
        parameters={
            "type": "object",
            "properties": {
                "path": {"type": "string", "description": "Relative memory file path."},
                "line_offset": {"type": "integer", "default": 1, "minimum": 1},
                "max_lines": {"type": ["integer", "null"], "minimum": 1},
                "max_tokens": {"type": "integer", "default": DEFAULT_READ_MAX_TOKENS, "minimum": 1},
            },
            "required": ["path"],
        },
        handler=read_memory,
    ))

    async def search_memories(
        queries: list[str],
        path: str | None = None,
        match_mode: str = "any",
        line_count: int = 3,
        cursor: str | None = None,
        context_lines: int = 2,
        case_sensitive: bool = False,
        normalized: bool = False,
        max_results: int = DEFAULT_SEARCH_MAX_RESULTS,
    ) -> str:
        payload = backend.search(
            queries=queries,
            path=path,
            match_mode=match_mode,
            line_count=line_count,
            cursor=cursor,
            context_lines=context_lines,
            case_sensitive=case_sensitive,
            normalized=normalized,
            max_results=max_results,
        )
        _record_usage(path or "MEMORY.md", "search")
        return _tool_output(payload)

    registry.register(ToolDefinition(
        name="search_memories",
        description=(
            "Search memory files by query strings. "
            "Use match_mode any, all_on_same_line, or all_within_lines."
        ),
        parameters={
            "type": "object",
            "properties": {
                "queries": {"type": "array", "items": {"type": "string"}, "minItems": 1},
                "path": {"type": ["string", "null"], "description": "Optional relative file or directory path."},
                "match_mode": {
                    "type": "string",
                    "enum": ["any", "all_on_same_line", "all_within_lines"],
                    "default": "any",
                },
                "line_count": {
                    "type": "integer",
                    "default": 3,
                    "minimum": 1,
                    "description": "Window size for all_within_lines.",
                },
                "cursor": {"type": ["string", "null"]},
                "context_lines": {"type": "integer", "default": 2, "minimum": 0},
                "case_sensitive": {"type": "boolean", "default": False},
                "normalized": {"type": "boolean", "default": False},
                "max_results": {"type": "integer", "default": DEFAULT_SEARCH_MAX_RESULTS, "minimum": 1, "maximum": DEFAULT_SEARCH_MAX_RESULTS},
            },
            "required": ["queries"],
        },
        handler=search_memories,
    ))

    return registry


def _tool_output(payload: dict[str, Any]) -> str:
    return json.dumps(payload, ensure_ascii=False, separators=(",", ":"))


__all__ = [
    "MemoryAccessError",
    "build_memory_tools",
]
