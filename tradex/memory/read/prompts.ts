import fs from "node:fs";
import path from "node:path";
import { memoryHome } from "../paths.js";

const MEMORY_SUMMARY_FILENAME = "memory_summary.md";
const MEMORY_SUMMARY_TOKEN_LIMIT = 5_000;
const APPROX_CHARS_PER_TOKEN = 4;

const READ_PATH_TEMPLATE = `## Memory

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
`;

function truncateText(text: string, maxTokens: number): string {
  const maxChars = maxTokens * APPROX_CHARS_PER_TOKEN;
  if (text.length <= maxChars) return text;
  const half = Math.floor(maxChars / 2);
  return text.slice(0, half) + "\n...[summary truncated]...\n" + text.slice(-half);
}

export function buildMemoryDeveloperInstructions(
  root?: string | null,
  maxSummaryTokens = MEMORY_SUMMARY_TOKEN_LIMIT,
): string | null {
  const basePath = memoryHome(root);
  const summaryPath = path.join(basePath, MEMORY_SUMMARY_FILENAME);
  let memorySummary: string;
  try {
    memorySummary = fs.readFileSync(summaryPath, "utf8").trim();
  } catch {
    return null;
  }
  memorySummary = truncateText(memorySummary, maxSummaryTokens);
  if (!memorySummary) return null;
  return READ_PATH_TEMPLATE.replace(/\{base_path\}/g, basePath).replace("{memory_summary}", memorySummary);
}
