"""文件用途：为 Codex 风格记忆读路径构造 prompt 注入内容。"""
from __future__ import annotations

from pathlib import Path

from ..backend import _truncate_text
from ..paths import memory_home

MEMORY_SUMMARY_FILENAME = "memory_summary.md"
MEMORY_SUMMARY_TOKEN_LIMIT = 5_000

_READ_PATH_TEMPLATE = """## Memory

You have access to a memory folder with guidance from prior runs. Use it when it is likely to help.

Decision boundary:
- Skip memory only when the request is clearly self-contained.
- Use memory for repo/workspace questions, prior decisions, repeated workflows, user preferences, or ambiguous tasks that may depend on history.

Memory layout:
- {base_path}/memory_summary.md is already provided below; do not open it again.
- {base_path}/MEMORY.md is the searchable registry.
- {base_path}/rollout_summaries/ contains detailed session evidence.
- {base_path}/skills/ contains reusable workflows.
- {base_path}/facts/ contains observed facts; do not treat facts as causal conclusions.
- {base_path}/reviews/ contains hypotheses or review notes; cite them as hypotheses, not facts.

Quick memory pass:
1. Extract task-relevant keywords from MEMORY_SUMMARY below.
2. Use search_memories against MEMORY.md.
3. Only open rollout_summaries, skills, facts, or reviews when MEMORY.md points there or the user explicitly asks.
4. Keep lookup small, ideally 4-6 tool calls.

When answering from memory:
- Say briefly when a fact is memory-derived and not verified in the current turn.
- Distinguish fact_ entries from review_ hypotheses.
- If memory may be stale, say so and offer to refresh from live data or code.
- If any memory file was used, append exactly one <oai-mem-citation> block as the final content.
- citation_entries lines must use: MEMORY.md:10-12|note=[short usage note]
- Include rollout_ids when a cited rollout summary exposes a UUID; leave that section empty otherwise.

Citation block format:
<oai-mem-citation>
<citation_entries>
MEMORY.md:10-12|note=[why this memory mattered]
rollout_summaries/example.md:3-8|note=[evidence used]
</citation_entries>
<rollout_ids>
</rollout_ids>
</oai-mem-citation>

========= MEMORY_SUMMARY BEGINS =========
{memory_summary}
========= MEMORY_SUMMARY ENDS =========
"""


def build_memory_developer_instructions(
    root: str | Path | None = None,
    *,
    max_summary_tokens: int = MEMORY_SUMMARY_TOKEN_LIMIT,
) -> str | None:
    """说明：存在 `memory_summary.md` 时生成记忆读取指令。"""
    base_path = memory_home(root)
    summary_path = base_path / MEMORY_SUMMARY_FILENAME
    try:
        memory_summary = summary_path.read_text().strip()
    except OSError:
        return None
    memory_summary = _truncate_text(memory_summary, max_summary_tokens)
    if not memory_summary:
        return None
    return _READ_PATH_TEMPLATE.format(
        base_path=base_path,
        memory_summary=memory_summary,
    )
