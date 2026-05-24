import type { AgentConfig } from "../../config/index.js";
import { nowMs } from "../../db.js";
import type { LLMChatClient } from "../../agent/llm_client.js";
import { DEFAULT_RETRY_DELAY_MS, type MemoryStateStore, type Stage1Output } from "../state.js";
import type { MemoryWorkspaceDiff } from "../workspace.js";
import {
  PHASE2_DIFF_FILENAME,
  hasChanges,
  memoryWorkspaceDiff,
  prepareMemoryWorkspace,
  resetMemoryWorkspaceBaseline,
  writeWorkspaceDiff,
} from "../workspace.js";
import {
  MEMORY_INDEX_FILENAME,
  MEMORY_SUMMARY_FILENAME,
  RAW_MEMORIES_FILENAME,
  jsonForPrompt,
  parseJsonObject,
  readMarkdownTree,
  readTextIfExists,
  redactSecrets,
} from "./renderers.js";
import { MemoryFileStorage } from "./storage.js";
import path from "node:path";

export const PHASE2_SYSTEM_PROMPT = `You are the tradex Memory Writing Agent, Phase 2 (Consolidation).

Consolidate raw_memories.md and rollout_summaries into progressive-disclosure memory files.
Output strict JSON only:
{"memory_md": string, "memory_summary_md": string}

You are running as an internal restricted worker: no tools, no network, no recursive memory reads or writes.
The only writable outputs are the two JSON string fields requested above.

MEMORY.md format:
# Task Group: <cwd / project / workflow>
scope: <what this block covers>
applies_to: cwd=<path-or-scope>; reuse_rule=<when safe to reuse>

## Task 1: <description, outcome>
### rollout_summary_files
- rollout_summaries/... (source metadata if known)
### keywords
- keyword1, keyword2, keyword3

Then include ## User preferences, ## Reusable knowledge, and ## Failures and how to do differently when meaningful.

memory_summary.md format:
## User Profile
## User preferences
## General Tips
## What's in Memory

Rules:
- Read the workspace diff first conceptually; changed raw/rollout inputs are the update queue.
- Preserve provenance and searchable wording.
- Keep facts and reviews separate: facts are observed only; reviews/hypotheses must be labeled as hypotheses.
- Remove stale references when inputs were deleted.
- Do not invent facts, claims, files, or validation.
`;

export type LLMProviderFactory = (config: AgentConfig) => LLMChatClient;

export class Phase2Runner {
  readonly root: string;
  readonly stateStore: MemoryStateStore;
  readonly storage: MemoryFileStorage;
  readonly agentConfigProvider: (() => AgentConfig | null) | null;
  readonly llmProviderFactory: LLMProviderFactory;
  readonly heartbeatIntervalMs: number;

  constructor(input: {
    root: string;
    stateStore: MemoryStateStore;
    storage: MemoryFileStorage;
    agentConfigProvider: (() => AgentConfig | null) | null;
    llmProviderFactory: LLMProviderFactory;
    heartbeatIntervalMs: number;
  }) {
    this.root = input.root;
    this.stateStore = input.stateStore;
    this.storage = input.storage;
    this.agentConfigProvider = input.agentConfigProvider;
    this.llmProviderFactory = input.llmProviderFactory;
    this.heartbeatIntervalMs = Math.max(1, input.heartbeatIntervalMs);
  }

  async runOnce(input: { limit?: number } = {}): Promise<boolean> {
    const limit = input.limit ?? 100;
    const claim = this.stateStore.claimPhase2();
    if (!claim) return false;

    try {
      await prepareMemoryWorkspace(this.root);
      const selected = this.stateStore.selectPhase2Inputs({ limit });
      const selectedSourceIds = selected.map((item) => item.sourceId);
      this.storage.syncFactAndReviewFiles(selected);
      const visibleOutputs = this.storage.outputsVisibleInMemory(selected);
      this.storage.syncRolloutAndMemoryFiles(visibleOutputs);
      this.storage.pruneOldExtensionResources();

      const diff = await memoryWorkspaceDiff(this.root);
      if (!hasChanges(diff)) {
        this.stateStore.markPhase2Succeeded({ selectedSourceIds });
        return false;
      }
      await writeWorkspaceDiff(this.root, diff);

      await this._runWithHeartbeat(
        this._runConsolidation(visibleOutputs, diff),
        claim.ownershipToken,
      );

      await resetMemoryWorkspaceBaseline(this.root);
      const completionWatermark = selected.reduce((max, item) => Math.max(max, item.generatedAt), nowMs());
      this.stateStore.markPhase2Succeeded({ completionWatermark, selectedSourceIds });
      return true;
    } catch (exc) {
      console.error("memory phase2 failed", exc);
      this.stateStore.markPhase2Failed({ error: String(exc), retryDelayMs: DEFAULT_RETRY_DELAY_MS });
      return false;
    }
  }

  private async _runWithHeartbeat(awaitable: Promise<void>, ownershipToken: string | null): Promise<void> {
    if (!ownershipToken) {
      await awaitable;
      return;
    }
    let resolved = false;
    const intervalId = setInterval(() => {
      if (resolved) return;
      if (!this.stateStore.heartbeatPhase2({ ownershipToken })) {
        resolved = true;
        clearInterval(intervalId);
      }
    }, this.heartbeatIntervalMs);

    try {
      await awaitable;
    } finally {
      resolved = true;
      clearInterval(intervalId);
    }
  }

  private async _runConsolidation(outputs: Stage1Output[], diff: MemoryWorkspaceDiff): Promise<void> {
    const agentConfig = this.agentConfigProvider?.() ?? null;

    if (this.agentConfigProvider != null) {
      if (!agentConfig?.enabled) throw new Error("memory Phase 2 requires an enabled agent model configuration");
      const provider = this.llmProviderFactory(agentConfig);
      const payload = this._consolidationPromptPayload(outputs, diff);
      const response = await provider.chat({
        messages: [
          { role: "system", content: PHASE2_SYSTEM_PROMPT },
          { role: "user", content: jsonForPrompt(payload, 180_000) },
        ],
        tools: null,
      });
      const parsed = parseJsonObject(response.content ?? "");
      const expectedKeys = new Set(["memory_md", "memory_summary_md"]);
      if (
        new Set(Object.keys(parsed)).size !== expectedKeys.size ||
        ![...expectedKeys].every((k) => k in parsed)
      ) {
        throw new Error("phase2 output must match the strict schema");
      }
      if (typeof parsed.memory_md !== "string" || typeof parsed.memory_summary_md !== "string") {
        throw new Error("phase2 output fields must be strings");
      }
      const memoryMd = redactSecrets(String(parsed.memory_md)).trim();
      const memorySummaryMd = redactSecrets(String(parsed.memory_summary_md)).trim();
      if (!memoryMd || !memorySummaryMd) {
        throw new Error("phase2 consolidation output must include memory_md and memory_summary_md");
      }
      this.storage.writeRelative(MEMORY_INDEX_FILENAME, memoryMd.trimEnd() + "\n");
      this.storage.writeRelative(MEMORY_SUMMARY_FILENAME, memorySummaryMd.trimEnd() + "\n");
      this.storage.sanitizeConsolidatedMemoryFiles();
      return;
    }

    this.storage.writeRelative(MEMORY_INDEX_FILENAME, this.storage.renderMemoryIndex(outputs));
    this.storage.writeRelative(MEMORY_SUMMARY_FILENAME, this.storage.renderMemorySummary(outputs));
    this.storage.sanitizeConsolidatedMemoryFiles();
  }

  private _consolidationPromptPayload(
    outputs: Stage1Output[],
    diff: MemoryWorkspaceDiff,
  ): Record<string, unknown> {
    return {
      memory_root: this.root,
      worker_policy: {
        ephemeral: true,
        generate_memories: false,
        use_memories: false,
      },
      workspace_diff: {
        changes: diff.changes.map((c) => ({ status: c.status, path: c.path })),
        unified_diff: diff.unifiedDiff,
        diff_file: PHASE2_DIFF_FILENAME,
        diff_file_content: readTextIfExists(path.join(this.root, PHASE2_DIFF_FILENAME)),
      },
      existing_memory_md: readTextIfExists(path.join(this.root, MEMORY_INDEX_FILENAME)),
      existing_memory_summary_md: readTextIfExists(path.join(this.root, MEMORY_SUMMARY_FILENAME)),
      raw_memories_md: readTextIfExists(path.join(this.root, RAW_MEMORIES_FILENAME)),
      rollout_summaries: readMarkdownTree(path.join(this.root, "rollout_summaries")),
      facts: readMarkdownTree(path.join(this.root, "facts")),
      reviews: readMarkdownTree(path.join(this.root, "reviews")),
      selected_sources: outputs.map((output) => ({
        source_id: output.sourceId,
        source_type: output.source.sourceType,
        source_ref: output.source.sourceRef,
        generated_at: output.generatedAt,
        rollout_summary_file: this.storage.rolloutSummaryRelativePath(output),
        usage_count: output.usageCount,
        last_usage: output.lastUsage,
      })),
    };
  }
}
