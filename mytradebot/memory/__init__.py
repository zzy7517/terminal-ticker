"""文件用途：mytradebot 本地记忆读路径入口。"""
from __future__ import annotations

from .backend import LocalMemoryBackend, MemoryAccessError
from .paths import ensure_memory_layout, default_memory_home, memory_home, memory_store_available
from .pipeline import MemoryPipeline
from .policy import MemoryRuntimePolicy
from .read.citations import MemoryCitationEntry, MemoryCitations, parse_memory_citations
from .read.prompts import build_memory_developer_instructions
from .state import (
    JOB_CLAIMED,
    JOB_FAILED,
    JOB_PENDING,
    JOB_SUCCEEDED,
    JOB_SUCCEEDED_NO_OUTPUT,
    SOURCE_AGENT_SESSION,
    SOURCE_MANUAL_NOTE,
    SOURCE_TRADE_EVENT,
    MemorySource,
    MemoryStateStore,
    Phase2Job,
    Stage1Job,
    Stage1Output,
)
from .tools import build_memory_tools
from .validators import MemoryValidationError, validate_fact_text, validate_review_metadata
from .workspace import (
    MemoryWorkspaceDiff,
    memory_workspace_diff,
    prepare_memory_workspace,
    reset_memory_workspace_baseline,
    write_workspace_diff,
)

__all__ = [
    "JOB_CLAIMED",
    "JOB_FAILED",
    "JOB_PENDING",
    "JOB_SUCCEEDED",
    "JOB_SUCCEEDED_NO_OUTPUT",
    "LocalMemoryBackend",
    "MemoryAccessError",
    "MemorySource",
    "MemoryStateStore",
    "MemoryPipeline",
    "MemoryRuntimePolicy",
    "MemoryCitationEntry",
    "MemoryCitations",
    "MemoryValidationError",
    "MemoryWorkspaceDiff",
    "Phase2Job",
    "SOURCE_AGENT_SESSION",
    "SOURCE_MANUAL_NOTE",
    "SOURCE_TRADE_EVENT",
    "Stage1Job",
    "Stage1Output",
    "build_memory_developer_instructions",
    "build_memory_tools",
    "default_memory_home",
    "ensure_memory_layout",
    "memory_home",
    "memory_store_available",
    "memory_workspace_diff",
    "parse_memory_citations",
    "prepare_memory_workspace",
    "reset_memory_workspace_baseline",
    "validate_fact_text",
    "validate_review_metadata",
    "write_workspace_diff",
]
