"""文件用途：Codex 风格 memory workspace git baseline 与 diff 管理。"""
from __future__ import annotations

import asyncio
from dataclasses import dataclass
import json
import os
from pathlib import Path
import shutil
import subprocess
from typing import Any

PHASE2_DIFF_FILENAME = "phase2_workspace_diff.md"
MAX_WORKSPACE_DIFF_BYTES = 4 * 1024 * 1024
_FALLBACK_BASELINE_FILENAME = ".phase2_baseline.json"
_GITIGNORE_CONTENT = "\n".join([
    "state.sqlite3",
    "state.sqlite3-*",
    "*.sqlite3",
    "*.sqlite3-*",
    PHASE2_DIFF_FILENAME,
    _FALLBACK_BASELINE_FILENAME,
    "",
])


@dataclass(frozen=True)
class MemoryWorkspaceChange:
    """说明：memory workspace 相对 baseline 的单个文件变更。"""

    status: str
    path: str


@dataclass(frozen=True)
class MemoryWorkspaceDiff:
    """说明：git baseline diff 的结构化结果。"""

    changes: tuple[MemoryWorkspaceChange, ...]
    unified_diff: str

    @property
    def has_changes(self) -> bool:
        return bool(self.changes or self.unified_diff.strip())


async def prepare_memory_workspace(root: str | Path) -> None:
    """说明：确保 memories root 可用，并准备 git baseline。"""
    await asyncio.to_thread(_prepare_memory_workspace_sync, Path(root))


async def memory_workspace_diff(root: str | Path) -> MemoryWorkspaceDiff:
    """说明：返回当前 memories root 相对最近 baseline 的 diff。"""
    return await asyncio.to_thread(_memory_workspace_diff_sync, Path(root))


async def write_workspace_diff(root: str | Path, diff: MemoryWorkspaceDiff) -> None:
    """说明：把 bounded workspace diff 写给 consolidation worker 阅读。"""
    path = Path(root) / PHASE2_DIFF_FILENAME
    await asyncio.to_thread(path.write_text, _render_workspace_diff_file(diff))


async def reset_memory_workspace_baseline(root: str | Path) -> None:
    """说明：把当前 memories root 提交为新的 baseline。"""
    await asyncio.to_thread(_reset_memory_workspace_baseline_sync, Path(root))


def _prepare_memory_workspace_sync(root: Path) -> None:
    root.mkdir(parents=True, exist_ok=True)
    _remove_workspace_diff(root)
    _ensure_gitignore(root)
    if _git_available():
        _ensure_git_repo(root)
        return
    _ensure_fallback_baseline(root)


def _memory_workspace_diff_sync(root: Path) -> MemoryWorkspaceDiff:
    _remove_workspace_diff(root)
    if _git_available() and (root / ".git").exists():
        _run_git(root, "add", "-A")
        status_output = _run_git(root, "diff", "--cached", "--name-status", "HEAD", "--").stdout
        diff_output = _run_git(root, "diff", "--cached", "--no-ext-diff", "HEAD", "--").stdout
        changes = tuple(_parse_name_status(status_output))
        return MemoryWorkspaceDiff(changes=changes, unified_diff=diff_output)
    return _fallback_workspace_diff(root)


def _reset_memory_workspace_baseline_sync(root: Path) -> None:
    _remove_workspace_diff(root)
    if _git_available() and (root / ".git").exists():
        _run_git(root, "add", "-A")
        status_output = _run_git(root, "diff", "--cached", "--name-status", "HEAD", "--").stdout
        if status_output.strip():
            _run_git(
                root,
                "commit",
                "-m",
                "memory phase2 baseline",
                env=_git_identity_env(),
            )
        return
    _write_fallback_baseline(root)


def _ensure_gitignore(root: Path) -> None:
    path = root / ".gitignore"
    if path.exists() and path.read_text() == _GITIGNORE_CONTENT:
        return
    path.write_text(_GITIGNORE_CONTENT)


def _ensure_git_repo(root: Path) -> None:
    if not (root / ".git").exists():
        _run_git(root, "init", "-q")
    try:
        _run_git(root, "rev-parse", "--verify", "HEAD")
    except RuntimeError:
        _run_git(root, "add", "-A")
        _run_git(
            root,
            "commit",
            "--allow-empty",
            "-m",
            "memory initial baseline",
            env=_git_identity_env(),
        )


def _run_git(root: Path, *args: str, env: dict[str, str] | None = None) -> subprocess.CompletedProcess[str]:
    merged_env = os.environ.copy()
    if env:
        merged_env.update(env)
    proc = subprocess.run(
        ("git", "-C", str(root), *args),
        check=False,
        text=True,
        capture_output=True,
        env=merged_env,
    )
    if proc.returncode != 0:
        detail = (proc.stderr or proc.stdout or "").strip()
        raise RuntimeError(f"git {' '.join(args)} failed: {detail}")
    return proc


def _git_identity_env() -> dict[str, str]:
    return {
        "GIT_AUTHOR_NAME": "mytradebot-memory",
        "GIT_AUTHOR_EMAIL": "memory@mytradebot.local",
        "GIT_COMMITTER_NAME": "mytradebot-memory",
        "GIT_COMMITTER_EMAIL": "memory@mytradebot.local",
    }


def _git_available() -> bool:
    return shutil.which("git") is not None


def _parse_name_status(output: str) -> list[MemoryWorkspaceChange]:
    changes: list[MemoryWorkspaceChange] = []
    for line in output.splitlines():
        if not line.strip():
            continue
        parts = line.split("\t")
        status = parts[0].strip()
        path = parts[-1].strip()
        if path:
            changes.append(MemoryWorkspaceChange(status=status, path=path))
    return changes


def _render_workspace_diff_file(diff: MemoryWorkspaceDiff) -> str:
    lines = [
        "# Memory Workspace Diff",
        "",
        "Generated by mytradebot before Phase 2 memory consolidation. Read this file first and do not edit it.",
        "",
        "## Status",
    ]
    if not diff.has_changes:
        lines.append("- none")
        return "\n".join(lines) + "\n"
    lines.extend(f"- {change.status} {change.path}" for change in diff.changes)
    lines.extend(["", "## Diff", "", "```diff"])
    lines.append(_bounded_diff(diff.unified_diff))
    lines.append("```")
    return "\n".join(lines).rstrip() + "\n"


def _bounded_diff(value: str) -> str:
    encoded = value.encode("utf-8")
    if len(encoded) <= MAX_WORKSPACE_DIFF_BYTES:
        return value.rstrip("\n")
    clipped = encoded[:MAX_WORKSPACE_DIFF_BYTES].decode("utf-8", errors="ignore")
    return clipped.rstrip("\n") + f"\n\n[workspace diff truncated at {MAX_WORKSPACE_DIFF_BYTES} bytes]"


def _remove_workspace_diff(root: Path) -> None:
    try:
        (root / PHASE2_DIFF_FILENAME).unlink()
    except FileNotFoundError:
        pass


def _ensure_fallback_baseline(root: Path) -> None:
    path = root / _FALLBACK_BASELINE_FILENAME
    if not path.exists():
        _write_fallback_baseline(root)


def _write_fallback_baseline(root: Path) -> None:
    (root / _FALLBACK_BASELINE_FILENAME).write_text(
        json.dumps(_snapshot_files(root), ensure_ascii=False, sort_keys=True)
    )


def _fallback_workspace_diff(root: Path) -> MemoryWorkspaceDiff:
    baseline_path = root / _FALLBACK_BASELINE_FILENAME
    baseline: dict[str, str] = {}
    if baseline_path.exists():
        try:
            parsed = json.loads(baseline_path.read_text())
            if isinstance(parsed, dict):
                baseline = {str(k): str(v) for k, v in parsed.items()}
        except json.JSONDecodeError:
            baseline = {}
    current = _snapshot_files(root)
    changed = sorted(path for path in set(baseline) | set(current) if baseline.get(path) != current.get(path))
    changes = tuple(
        MemoryWorkspaceChange(
            status="A" if path not in baseline else "D" if path not in current else "M",
            path=path,
        )
        for path in changed
    )
    return MemoryWorkspaceDiff(changes=changes, unified_diff=_render_fallback_unified_diff(baseline, current, changed))


def _snapshot_files(root: Path) -> dict[str, str]:
    files: dict[str, str] = {}
    for path in root.rglob("*"):
        if not path.is_file() or _ignored_for_snapshot(root, path):
            continue
        try:
            files[path.relative_to(root).as_posix()] = path.read_text()
        except UnicodeDecodeError:
            continue
    return files


def _ignored_for_snapshot(root: Path, path: Path) -> bool:
    relative = path.relative_to(root)
    parts = relative.parts
    if any(part in {".git", "__pycache__"} for part in parts):
        return True
    if any(part.startswith(".") for part in parts):
        return True
    name = path.name
    return (
        name == PHASE2_DIFF_FILENAME
        or name.endswith(".sqlite3")
        or ".sqlite3-" in name
    )


def _render_fallback_unified_diff(before: dict[str, str], after: dict[str, str], paths: list[str]) -> str:
    import difflib

    chunks: list[str] = []
    for path in paths:
        old = before.get(path, "").splitlines(keepends=True)
        new = after.get(path, "").splitlines(keepends=True)
        chunks.append("".join(difflib.unified_diff(old, new, fromfile=f"a/{path}", tofile=f"b/{path}")))
    return "".join(chunks)


__all__ = [
    "MAX_WORKSPACE_DIFF_BYTES",
    "MemoryWorkspaceChange",
    "MemoryWorkspaceDiff",
    "PHASE2_DIFF_FILENAME",
    "memory_workspace_diff",
    "prepare_memory_workspace",
    "reset_memory_workspace_baseline",
    "write_workspace_diff",
]
