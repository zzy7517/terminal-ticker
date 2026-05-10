"""文件用途：复刻 Codex 的本地记忆 list/read/search 后端。"""
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
import os
import re
from typing import Any

from .paths import memory_home

DEFAULT_LIST_MAX_RESULTS = 2_000
MAX_LIST_RESULTS = 2_000
DEFAULT_SEARCH_MAX_RESULTS = 200
MAX_SEARCH_RESULTS = 200
DEFAULT_READ_MAX_TOKENS = 20_000
DEFAULT_CONTEXT_LINES = 2
VISIBLE_ROOT_FILES = {"MEMORY.md", "memory_summary.md"}
VISIBLE_ROOT_DIRS = {"facts", "reviews", "rollout_summaries", "skills"}
INTERNAL_FILENAMES = {"phase2_workspace_diff.md", ".phase2_baseline.json"}
INTERNAL_SUFFIXES = (".sqlite3", ".sqlite3-shm", ".sqlite3-wal")


class MemoryAccessError(ValueError):
    """说明：记忆路径或请求参数不合法。"""


@dataclass(frozen=True)
class LocalMemoryBackend:
    """说明：限制在 memories root 内的只读文件系统后端。"""

    root: Path | str | None = None

    def __post_init__(self) -> None:
        object.__setattr__(self, "root", memory_home(self.root))

    def list(
        self,
        *,
        path: str | None = None,
        cursor: str | None = None,
        max_results: int = DEFAULT_LIST_MAX_RESULTS,
    ) -> dict[str, Any]:
        """说明：列出记忆目录，或返回单个文件条目。"""
        max_results = _clamp_positive(max_results, MAX_LIST_RESULTS)
        start = self._resolve_scoped_path(path)
        start_index = _parse_cursor(cursor)
        if not start.exists():
            raise MemoryAccessError(f"path '{path or ''}' was not found")
        self._reject_symlink(start)

        if start.is_file():
            entries = [{
                "path": self._display_relative_path(start),
                "entryType": "file",
            }]
        elif start.is_dir():
            entries = []
            for child in sorted(start.iterdir(), key=lambda item: item.name):
                if (
                    _is_hidden_path(child)
                    or _is_symlink(child)
                    or not _is_visible_path(self.root, child)
                ):
                    continue
                if child.is_dir():
                    entry_type = "directory"
                elif child.is_file():
                    entry_type = "file"
                else:
                    continue
                entries.append({
                    "path": self._display_relative_path(child),
                    "entryType": entry_type,
                })
        else:
            entries = []

        if start_index > len(entries):
            raise MemoryAccessError(f"cursor '{start_index}' exceeds result count")
        end_index = min(start_index + max_results, len(entries))
        next_cursor = str(end_index) if end_index < len(entries) else None
        return {
            "path": path,
            "entries": entries[start_index:end_index],
            "nextCursor": next_cursor,
            "truncated": next_cursor is not None,
        }

    def read(
        self,
        *,
        path: str,
        line_offset: int = 1,
        max_lines: int | None = None,
        max_tokens: int = DEFAULT_READ_MAX_TOKENS,
    ) -> dict[str, Any]:
        """说明：按 1 起始行号读取记忆文件。"""
        if line_offset < 1:
            raise MemoryAccessError("line_offset must be a 1-indexed line number")
        if max_lines is not None and max_lines < 1:
            raise MemoryAccessError("max_lines must be a positive integer")

        resolved = self._resolve_scoped_path(path)
        if not resolved.exists():
            raise MemoryAccessError(f"path '{path}' was not found")
        self._reject_symlink(resolved)
        if not resolved.is_file():
            raise MemoryAccessError(f"path '{path}' is not a file")

        original_content = resolved.read_text()
        content_from_offset, sliced_by_lines = _slice_lines(
            original_content,
            line_offset=line_offset,
            max_lines=max_lines,
        )
        token_limit = max_tokens if max_tokens > 0 else DEFAULT_READ_MAX_TOKENS
        content = _truncate_text(content_from_offset, token_limit)
        return {
            "path": path,
            "startLineNumber": line_offset,
            "content": content,
            "truncated": sliced_by_lines or content != content_from_offset,
        }

    def search(
        self,
        *,
        queries: list[str],
        path: str | None = None,
        match_mode: str = "any",
        line_count: int = 3,
        cursor: str | None = None,
        context_lines: int = DEFAULT_CONTEXT_LINES,
        case_sensitive: bool = False,
        normalized: bool = False,
        max_results: int = DEFAULT_SEARCH_MAX_RESULTS,
    ) -> dict[str, Any]:
        """说明：用 Codex 兼容的匹配模式搜索记忆文件。"""
        prepared_queries = [query.strip() for query in queries]
        if not prepared_queries or any(not query for query in prepared_queries):
            raise MemoryAccessError("queries must not be empty or contain empty strings")
        if match_mode not in {"any", "all_on_same_line", "all_within_lines"}:
            raise MemoryAccessError(f"invalid match_mode: {match_mode}")
        if match_mode == "all_within_lines" and line_count < 1:
            raise MemoryAccessError("all_within_lines.line_count must be a positive integer")

        max_results = _clamp_positive(max_results, MAX_SEARCH_RESULTS)
        start_index = _parse_cursor(cursor)
        start = self._resolve_scoped_path(path)
        if not start.exists():
            raise MemoryAccessError(f"path '{path or ''}' was not found")
        self._reject_symlink(start)

        matcher = _SearchMatcher(
            queries=prepared_queries,
            match_mode=match_mode,
            line_count=line_count,
            case_sensitive=case_sensitive,
            normalized=normalized,
        )
        if any(not query for query in matcher.prepared_queries):
            raise MemoryAccessError("queries must not be empty or contain empty strings")
        matches: list[dict[str, Any]] = []
        for file_path in self._iter_search_files(start):
            matches.extend(_search_file(self.root, file_path, matcher, max(0, context_lines)))
        matches.sort(key=lambda item: (item["path"], item["matchLineNumber"]))

        if start_index > len(matches):
            raise MemoryAccessError(f"cursor '{start_index}' exceeds result count")
        end_index = min(start_index + max_results, len(matches))
        next_cursor = str(end_index) if end_index < len(matches) else None
        return {
            "queries": prepared_queries,
            "matchMode": {"type": match_mode, "lineCount": line_count}
            if match_mode == "all_within_lines"
            else {"type": match_mode},
            "path": path,
            "matches": matches[start_index:end_index],
            "nextCursor": next_cursor,
            "truncated": next_cursor is not None,
        }

    def _resolve_scoped_path(self, relative_path: str | None) -> Path:
        if relative_path is None or relative_path == "":
            return self.root
        relative = Path(relative_path)
        if relative.is_absolute() or any(part == ".." for part in relative.parts):
            raise MemoryAccessError(f"path '{relative_path}' must stay within the memories root")
        if any(part.startswith(".") for part in relative.parts):
            raise MemoryAccessError(f"path '{relative_path}' was not found")
        if not _is_visible_relative_path(relative):
            raise MemoryAccessError(f"path '{relative_path}' was not found")

        scoped = self.root
        parts = list(relative.parts)
        for index, part in enumerate(parts):
            scoped = scoped / part
            if not scoped.exists():
                for remaining in parts[index + 1:]:
                    scoped = scoped / remaining
                return scoped
            self._reject_symlink(scoped)
            if index + 1 < len(parts) and not scoped.is_dir():
                raise MemoryAccessError(
                    f"path '{relative_path}' traverses through a non-directory path component"
                )
        return scoped

    def _reject_symlink(self, path: Path) -> None:
        if _is_symlink(path):
            raise MemoryAccessError(f"path '{self._display_relative_path(path)}' must not be a symlink")

    def _iter_search_files(self, start: Path) -> list[Path]:
        if start.is_file():
            return [start]
        if not start.is_dir():
            return []
        files: list[Path] = []
        for current, dirs, filenames in os.walk(start):
            current_path = Path(current)
            dirs[:] = sorted(
                dirname for dirname in dirs
                if not dirname.startswith(".")
                and not _is_symlink(current_path / dirname)
                and _is_visible_path(self.root, current_path / dirname)
            )
            for filename in sorted(filenames):
                file_path = current_path / filename
                if (
                    filename.startswith(".")
                    or _is_symlink(file_path)
                    or not file_path.is_file()
                    or not _is_visible_path(self.root, file_path)
                ):
                    continue
                files.append(file_path)
        return files

    def _display_relative_path(self, path: Path) -> str:
        try:
            return path.relative_to(self.root).as_posix()
        except ValueError:
            return path.as_posix()


@dataclass(frozen=True)
class _SearchMatcher:
    queries: list[str]
    match_mode: str
    line_count: int
    case_sensitive: bool
    normalized: bool

    def matched_flags(self, line: str) -> list[bool]:
        prepared_line = self._prepare(line)
        return [query in prepared_line for query in self.prepared_queries]

    def matched_queries(self, flags: list[bool]) -> list[str]:
        return [query for query, matched in zip(self.queries, flags) if matched]

    @property
    def prepared_queries(self) -> list[str]:
        return [self._prepare(query) for query in self.queries]

    def _prepare(self, value: str) -> str:
        if not self.case_sensitive:
            value = value.lower()
        if self.normalized:
            value = "".join(char for char in value if char.isalnum())
        return value


def _search_file(
    root: Path,
    path: Path,
    matcher: _SearchMatcher,
    context_lines: int,
) -> list[dict[str, Any]]:
    try:
        content = path.read_text()
    except UnicodeDecodeError:
        return []
    lines = content.splitlines()
    line_matches = [matcher.matched_flags(line) for line in lines]
    matches: list[dict[str, Any]] = []

    if matcher.match_mode == "any":
        for index, flags in enumerate(line_matches):
            if any(flags):
                matches.append(_build_match(root, path, lines, index, index, context_lines, matcher.matched_queries(flags)))
        return matches

    if matcher.match_mode == "all_on_same_line":
        for index, flags in enumerate(line_matches):
            if all(flags):
                matches.append(_build_match(root, path, lines, index, index, context_lines, matcher.matched_queries(flags)))
        return matches

    windows: list[tuple[int, int, list[bool]]] = []
    for start_index, flags in enumerate(line_matches):
        if not any(flags):
            continue
        last_allowed_index = min(start_index + matcher.line_count - 1, len(lines) - 1)
        matched_flags = [False for _ in matcher.queries]
        for end_index in range(start_index, last_allowed_index + 1):
            for idx, matched in enumerate(line_matches[end_index]):
                matched_flags[idx] = matched_flags[idx] or matched
            if all(matched_flags):
                windows.append((start_index, end_index, list(matched_flags)))
                break

    for index, (start_index, end_index, flags) in enumerate(windows):
        contains_smaller = any(
            index != other_index
            and start_index <= other_start
            and end_index >= other_end
            and (start_index != other_start or end_index != other_end)
            for other_index, (other_start, other_end, _) in enumerate(windows)
        )
        if contains_smaller:
            continue
        matches.append(_build_match(root, path, lines, start_index, end_index, context_lines, matcher.matched_queries(flags)))
    return matches


def _build_match(
    root: Path,
    path: Path,
    lines: list[str],
    match_start_index: int,
    match_end_index: int,
    context_lines: int,
    matched_queries: list[str],
) -> dict[str, Any]:
    content_start_index = max(0, match_start_index - context_lines)
    content_end_index = min(len(lines), match_end_index + context_lines + 1)
    return {
        "path": path.relative_to(root).as_posix(),
        "matchLineNumber": match_start_index + 1,
        "contentStartLineNumber": content_start_index + 1,
        "content": "\n".join(lines[content_start_index:content_end_index]),
        "matchedQueries": matched_queries,
    }


def _slice_lines(content: str, *, line_offset: int, max_lines: int | None) -> tuple[str, bool]:
    if content == "":
        if line_offset == 1:
            return "", False
        raise MemoryAccessError("line_offset exceeds file length")
    lines = content.splitlines(keepends=True)
    if content.endswith("\n") and line_offset == len(lines) + 1:
        return "", False
    if line_offset > len(lines):
        raise MemoryAccessError("line_offset exceeds file length")
    start = line_offset - 1
    end = None if max_lines is None else start + max_lines
    sliced = "".join(lines[start:end])
    sliced_by_lines = end is not None and end < len(lines)
    return sliced, sliced_by_lines


def _truncate_text(content: str, max_tokens: int) -> str:
    if max_tokens <= 0:
        max_tokens = DEFAULT_READ_MAX_TOKENS
    token_chunks = re.findall(r"\S+\s*", content)
    if len(token_chunks) > max_tokens:
        return "".join(token_chunks[:max_tokens])
    char_limit = max_tokens * 8
    if len(content) > char_limit:
        return content[:char_limit]
    return content


def _parse_cursor(cursor: str | None) -> int:
    if cursor is None:
        return 0
    try:
        value = int(cursor)
    except ValueError as exc:
        raise MemoryAccessError(f"cursor '{cursor}' must be a non-negative integer") from exc
    if value < 0:
        raise MemoryAccessError(f"cursor '{cursor}' must be a non-negative integer")
    return value


def _clamp_positive(value: int, maximum: int) -> int:
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        parsed = maximum
    return max(1, min(parsed, maximum))


def _is_hidden_path(path: Path) -> bool:
    return path.name.startswith(".")


def _is_symlink(path: Path) -> bool:
    try:
        return path.is_symlink()
    except OSError:
        return True


def _is_visible_path(root: Path, path: Path) -> bool:
    try:
        relative = path.relative_to(root)
    except ValueError:
        return False
    return _is_visible_relative_path(relative)


def _is_visible_relative_path(path: Path) -> bool:
    parts = path.parts
    if not parts:
        return True
    if any(part.startswith(".") for part in parts):
        return False
    if any(_is_internal_filename(part) for part in parts):
        return False
    root_name = parts[0]
    if len(parts) == 1 and root_name in VISIBLE_ROOT_FILES:
        return True
    return root_name in VISIBLE_ROOT_DIRS


def _is_internal_filename(name: str) -> bool:
    return name in INTERNAL_FILENAMES or any(name.endswith(suffix) for suffix in INTERNAL_SUFFIXES)
