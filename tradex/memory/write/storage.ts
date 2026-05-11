import fs from "node:fs";
import path from "node:path";
import { nowMs } from "../../db.js";
import { FillKind, type Trade } from "../../trading/models.js";
import type { TradeStore } from "../../trading/store.js";
import { memoryHome } from "../paths.js";
import { SOURCE_AGENT_SESSION, SOURCE_TRADE_EVENT, type Stage1Output } from "../state.js";
import { validateFactText, validateReviewMetadata } from "../validators.js";
import {
  LEGACY_MANUAL_NOTE_DIRNAME,
  MANUAL_NOTE_DIRNAME,
  MEMORY_INDEX_FILENAME,
  MEMORY_SUMMARY_FILENAME,
  RAW_MEMORIES_FILENAME,
  cleanToken,
  exitFillKind,
  extractPreferenceSignalsFromOutputs,
  factSummaryFromMarkdown,
  filenameTimestamp,
  formatNumber,
  formatTimestampMs,
  groupOutputs,
  keywordsForOutput,
  removeStaleGeneratedReferences,
  uniqueStrings,
} from "./renderers.js";

export class MemoryFileStorage {
  readonly root: string;
  readonly tradeStore: TradeStore;
  readonly extensionRetentionDays: number;

  constructor(input: { root: string; tradeStore: TradeStore; extensionRetentionDays: number }) {
    this.root = input.root;
    this.tradeStore = input.tradeStore;
    this.extensionRetentionDays = Math.max(0, input.extensionRetentionDays);
  }

  writeManualNoteFile(input: { noteId: string; payload: string | Record<string, unknown> }): string {
    const noteKey = cleanToken(input.noteId, "note")!;
    const notePath = this.manualNotePath(noteKey);
    fs.mkdirSync(path.dirname(notePath), { recursive: true });
    const serializable = typeof input.payload === "object" ? input.payload : { text: String(input.payload) };
    fs.writeFileSync(notePath, JSON.stringify(serializable, null, 2));
    return noteKey;
  }

  manualNotePath(noteRef: string, mustExist = false): string {
    const primary = path.join(this.root, MANUAL_NOTE_DIRNAME, `${noteRef}.json`);
    if (!mustExist || fs.existsSync(primary)) return primary;
    const legacy = path.join(this.root, LEGACY_MANUAL_NOTE_DIRNAME, `${noteRef}.json`);
    return fs.existsSync(legacy) ? legacy : primary;
  }

  syncRolloutAndMemoryFiles(outputs: Stage1Output[]): Set<string> {
    const expectedPaths = new Set<string>([RAW_MEMORIES_FILENAME]);
    const rolloutDir = path.join(this.root, "rollout_summaries");
    fs.mkdirSync(rolloutDir, { recursive: true });

    const sorted = [...outputs].sort((a, b) => a.source.updatedAt - b.source.updatedAt || a.sourceId - b.sourceId);
    const renderedRollouts: Array<[string, string]> = [];
    for (const output of sorted) {
      const relativePath = this.rolloutSummaryRelativePath(output);
      renderedRollouts.push([relativePath, this.renderRolloutSummary(output)]);
      expectedPaths.add(relativePath);
    }
    this.pruneGeneratedFiles(rolloutDir, expectedPaths);
    for (const [relativePath, content] of renderedRollouts) {
      this.writeRelative(relativePath, content);
    }
    this.writeRelative(RAW_MEMORIES_FILENAME, this.renderRawMemories(outputs));
    return expectedPaths;
  }

  syncFactAndReviewFiles(outputs: Stage1Output[]): void {
    const expectedFacts = new Set<string>();
    const expectedReviews = new Set<string>();

    for (const output of outputs) {
      if (output.source.sourceType !== SOURCE_TRADE_EVENT) continue;
      const factRelative = this.tradeFactRelativePath(output);
      if (this.managedTradeFactWasDeleted(output, factRelative)) continue;

      const factContent = this.renderTradeFact(output);
      validateFactText(factSummaryFromMarkdown(factContent));
      this.writeRelative(factRelative, factContent);
      expectedFacts.add(factRelative);

      const reviewRelative = this.tradeReviewRelativePath(output);
      const reviewContent = this.renderTradeReview(output);
      if (reviewContent != null) {
        this.writeRelative(reviewRelative, reviewContent);
        expectedReviews.add(reviewRelative);
      }
    }

    this.pruneGeneratedFiles(path.join(this.root, "facts"), expectedFacts);
    this.pruneGeneratedFiles(path.join(this.root, "reviews"), expectedReviews);
  }

  renderRolloutSummary(output: Stage1Output): string {
    const generated = formatTimestampMs(output.generatedAt);
    return [
      `# Source ${output.sourceId}: ${output.source.sourceType}`,
      `generated_at: ${generated}`,
      `source_ref: ${output.source.sourceRef}`,
      `source_updated_at: ${formatTimestampMs(output.source.updatedAt)}`,
      "",
      "## Rollout Summary",
      output.rolloutSummary || "(empty)",
      "",
      "## Raw Memory",
      output.rawMemory || "(empty)",
      "",
    ].join("\n");
  }

  renderRawMemories(outputs: Stage1Output[]): string {
    const lines = ["# Raw Memories", ""];
    const sorted = [...outputs].sort((a, b) => a.sourceId - b.sourceId);
    for (const output of sorted) {
      lines.push(
        `## Source ${output.sourceId}: ${output.source.sourceType}`,
        `source_ref: ${output.source.sourceRef}`,
        output.rawMemory,
        "",
      );
    }
    return lines.join("\n").trimEnd() + "\n";
  }

  renderMemoryIndex(outputs: Stage1Output[]): string {
    const groups = groupOutputs(this.outputsVisibleInMemory(outputs));
    const lines: string[] = [];
    for (const [groupName, entries] of groups) {
      lines.push(
        `# Task Group: ${groupName}`,
        `scope: ${groupName} 的本地记忆索引`,
        `applies_to: cwd=${path.dirname(memoryHome(this.root))}; reuse_rule=优先读 rollout summary，再决定是否继续追查。`,
        "",
      );
      entries.forEach((output, index) => {
        lines.push(
          `## Task ${index + 1}: ${output.rolloutSummary || output.source.sourceRef}`,
          "### rollout_summary_files",
          `- ${this.rolloutSummaryRelativePath(output)}`,
        );
        const memoryFiles = this.memoryFilesForOutput(output);
        if (memoryFiles.length) {
          lines.push("### memory_files");
          lines.push(...memoryFiles.map((p) => `- ${p}`));
        }
        lines.push("### keywords");
        lines.push(...keywordsForOutput(output).map((k) => `- ${k}`));
        lines.push("");
      });

      if (groupName === "Agent Sessions") {
        const preferences = extractPreferenceSignalsFromOutputs(entries);
        if (preferences.length) {
          lines.push("## User preferences");
          lines.push(...preferences.map((p) => `- ${p}`));
          lines.push("");
        }
      }
      if (groupName === "Closed Trades") {
        lines.push("## Reusable knowledge");
        for (const output of entries) lines.push(`- ${output.rolloutSummary}`);
        lines.push("");
      }
    }
    return lines.join("\n").trimEnd() + "\n";
  }

  renderMemorySummary(outputs: Stage1Output[]): string {
    const groups = groupOutputs(this.outputsVisibleInMemory(outputs));
    const lines = [
      "## User Profile",
      "用户在 tradex 里进行本地交易研究、会话记录和交易复盘。",
      "",
      "## User preferences",
    ];
    const sessionOutputs = groups.flatMap(([, group]) => group).filter((o) => o.source.sourceType === SOURCE_AGENT_SESSION);
    const preferences = extractPreferenceSignalsFromOutputs(sessionOutputs);
    if (preferences.length) {
      lines.push(...preferences.map((p) => `- ${p}`));
    } else {
      lines.push("- 暂无稳定偏好，必要时回看具体 rollout summary。");
    }
    lines.push(
      "",
      "## General Tips",
      "- 交易事实只来自已关闭交易和结构化导出，不把复盘假设写成事实。",
      "- 需要细节时先查 MEMORY.md，再按路径打开 rollout_summaries/ 或 facts/。",
      "",
      "## What's in Memory",
    );
    for (const [groupName, entries] of groups) {
      lines.push(`### ${groupName}`);
      for (const output of entries) {
        lines.push(`- ${formatTimestampMs(output.generatedAt).slice(0, 10)}: ${output.rolloutSummary}`);
      }
      lines.push("");
    }
    return lines.join("\n").trimEnd() + "\n";
  }

  renderTradeFact(output: Stage1Output): string {
    const trade = this.tradeStore.getTrade(parseInt(output.source.sourceRef, 10));
    if (!trade) throw new Error(`trade not found: ${output.source.sourceRef}`);
    const date = formatTimestampMs(trade.closedAtMs ?? trade.updatedAtMs).slice(0, 10);
    const summary = `${trade.instrumentKey} ${trade.direction} trade closed with realized_pnl=${formatNumber(trade.realizedPnl)} and exit=${exitFillKind(trade.fills)}.`;
    validateFactText(summary);
    return [
      "---",
      `id: ${this.tradeFactId(output)}`,
      "type: trade_fact",
      `date: ${date}`,
      "source_type: trade_store",
      `source_ref: trade_id=${trade.id} snapshot_id=${trade.snapshotId ?? "n/a"}`,
      "confidence: observed",
      "tags:",
      `  - ${trade.instrumentKey}`,
      `  - ${trade.direction}`,
      `  - ${exitFillKind(trade.fills)}`,
      "---",
      `事实摘要：${summary}`,
      "",
    ].join("\n");
  }

  renderTradeReview(output: Stage1Output): string | null {
    const trade = this.tradeStore.getTrade(parseInt(output.source.sourceRef, 10));
    if (!trade) throw new Error(`trade not found: ${output.source.sourceRef}`);
    const lessons = this.tradeStore.listLessons({ tradeId: trade.id, limit: 20 });
    if (!lessons.length) return null;

    const factId = this.tradeFactId(output);
    const metadata = { based_on: [factId], sample_count: lessons.length };
    validateReviewMetadata(metadata);
    const date = formatTimestampMs(trade.closedAtMs ?? trade.updatedAtMs).slice(0, 10);
    const tags = uniqueStrings(lessons.flatMap((l) => (l.tags as string[]) ?? []));
    const categories = uniqueStrings(lessons.map((l) => String(l.category ?? "")));

    const lines = [
      "---",
      `id: ${this.tradeReviewId(output)}`,
      "type: trading_review",
      "status: hypothesis",
      "based_on:",
      `  - ${factId}`,
      `sample_count: ${lessons.length}`,
      `date: ${date}`,
      "source_type: trade_lessons",
      `source_ref: trade_id=${trade.id}`,
    ];
    if (categories.length) {
      lines.push("categories:");
      lines.push(...categories.map((c) => `  - ${c}`));
    }
    if (tags.length) {
      lines.push("tags:");
      lines.push(...tags.map((t) => `  - ${t}`));
    }
    lines.push("---", "复盘假设：");
    for (const lesson of lessons) {
      const text = String(lesson.text ?? "").trim();
      if (text) lines.push(`- lesson_id=${lesson.id}: ${text}`);
    }
    lines.push("");
    return lines.join("\n");
  }

  rolloutSummaryRelativePath(output: Stage1Output): string {
    const stamp = filenameTimestamp(output.source.updatedAt);
    const slug = output.rolloutSlug || `${output.source.sourceType}-${output.sourceId}`;
    return `rollout_summaries/${stamp}-s${output.sourceId}-${slug}.md`;
  }

  tradeFactRelativePath(output: Stage1Output): string {
    const trade = this.tradeStore.getTrade(parseInt(output.source.sourceRef, 10));
    if (!trade) throw new Error(`trade not found: ${output.source.sourceRef}`);
    const closedAt = trade.closedAtMs ?? trade.updatedAtMs;
    const d = new Date(closedAt);
    const pad2 = (n: number) => String(n).padStart(2, "0");
    const yearMonth = `${d.getUTCFullYear()}/${pad2(d.getUTCMonth() + 1)}`;
    const dateStr = `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
    const slug = output.rolloutSlug || `trade-${trade.id}`;
    return `facts/trading/${yearMonth}/${dateStr}-s${output.sourceId}-${slug}.md`;
  }

  tradeReviewRelativePath(output: Stage1Output): string {
    const trade = this.tradeStore.getTrade(parseInt(output.source.sourceRef, 10));
    if (!trade) throw new Error(`trade not found: ${output.source.sourceRef}`);
    const closedAt = trade.closedAtMs ?? trade.updatedAtMs;
    const d = new Date(closedAt);
    const pad2 = (n: number) => String(n).padStart(2, "0");
    const yearMonth = `${d.getUTCFullYear()}/${pad2(d.getUTCMonth() + 1)}`;
    const dateStr = `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
    const slug = output.rolloutSlug || `trade-${trade.id}`;
    return `reviews/trading/${yearMonth}/${dateStr}-s${output.sourceId}-${slug}-review.md`;
  }

  tradeFactId(output: Stage1Output): string {
    return `fact_trade_s${output.sourceId}`;
  }

  tradeReviewId(output: Stage1Output): string {
    return `review_trade_s${output.sourceId}`;
  }

  managedTradeFactWasDeleted(output: Stage1Output, factRelative: string): boolean {
    return output.selectedForPhase2 && !fs.existsSync(path.join(this.root, factRelative));
  }

  outputsVisibleInMemory(outputs: Stage1Output[]): Stage1Output[] {
    const visible: Stage1Output[] = [];
    for (const output of outputs) {
      if (output.source.sourceType === SOURCE_TRADE_EVENT) {
        try {
          const factRelative = this.tradeFactRelativePath(output);
          if (!fs.existsSync(path.join(this.root, factRelative))) continue;
        } catch { continue; }
      }
      visible.push(output);
    }
    return visible;
  }

  memoryFilesForOutput(output: Stage1Output): string[] {
    if (output.source.sourceType !== SOURCE_TRADE_EVENT) return [];
    const paths: string[] = [];
    try {
      const factRelative = this.tradeFactRelativePath(output);
      if (fs.existsSync(path.join(this.root, factRelative))) paths.push(factRelative);
      const reviewRelative = this.tradeReviewRelativePath(output);
      if (fs.existsSync(path.join(this.root, reviewRelative))) paths.push(reviewRelative);
    } catch { /* trade may no longer exist */ }
    return paths;
  }

  sanitizeConsolidatedMemoryFiles(): void {
    for (const relativePath of [MEMORY_INDEX_FILENAME, MEMORY_SUMMARY_FILENAME]) {
      const target = path.join(this.root, relativePath);
      if (!fs.existsSync(target)) continue;
      const original = fs.readFileSync(target, "utf8");
      const sanitized = removeStaleGeneratedReferences(original, this.root);
      if (sanitized !== original) this.writeRelative(relativePath, sanitized);
    }
  }

  writeRelative(relativePath: string, content: string): void {
    const target = path.join(this.root, relativePath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }

  pruneGeneratedFiles(root: string, expected: Set<string>): void {
    if (!fs.existsSync(root)) return;
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) { walk(full); continue; }
        if (!entry.name.endsWith(".md")) continue;
        const relative = path.relative(this.root, full).replace(/\\/g, "/");
        if (expected.has(relative)) continue;
        if (!entry.name.includes("-s")) continue;
        fs.unlinkSync(full);
      }
    };
    walk(root);
  }

  pruneOldExtensionResources(): void {
    if (this.extensionRetentionDays <= 0) return;
    const cutoff = nowMs() - this.extensionRetentionDays * 86_400_000;
    for (const relativeDir of [MANUAL_NOTE_DIRNAME, LEGACY_MANUAL_NOTE_DIRNAME]) {
      const dirRoot = path.join(this.root, relativeDir);
      if (!fs.existsSync(dirRoot)) continue;
      const walk = (dir: string) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) { walk(full); continue; }
          if (!entry.isFile()) continue;
          try {
            const stat = fs.statSync(full);
            if (stat.mtimeMs < cutoff) fs.unlinkSync(full);
          } catch { /* ignore */ }
        }
      };
      walk(dirRoot);
    }
  }
}
