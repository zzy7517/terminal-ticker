import fs from "node:fs";
import path from "node:path";
import { FillKind, type Fill } from "../../trading/models.js";
import {
  SOURCE_AGENT_SESSION,
  SOURCE_MANUAL_NOTE,
  SOURCE_TRADE_EVENT,
  type Stage1Output,
} from "../state.js";

export const RAW_MEMORIES_FILENAME = "raw_memories.md";
export const MEMORY_INDEX_FILENAME = "MEMORY.md";
export const MEMORY_SUMMARY_FILENAME = "memory_summary.md";
export const MANUAL_NOTE_DIRNAME = "extensions/ad_hoc/notes";
export const LEGACY_MANUAL_NOTE_DIRNAME = "extensions/manual_notes";

export function cleanToken(value: unknown, fallback: string | null = null): string | null {
  if (value == null) return fallback;
  const clean = String(value)
    .trim()
    .replace(/[^a-zA-Z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
  return clean || fallback;
}

export function parseJsonObject(content: string): Record<string, unknown> {
  const text = stripJsonFence(content).trim();
  const parsed = JSON.parse(text) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("LLM memory output must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}

export function stripJsonFence(content: string): string {
  let text = content.trim();
  if (!text.startsWith("```")) return text;
  text = text.replace(/^`+/, "").replace(/`+$/, "").trim();
  const nl = text.indexOf("\n");
  if (nl >= 0) {
    const firstLine = text.slice(0, nl).trim().toLowerCase();
    if (firstLine === "json" || firstLine === "javascript") {
      return text.slice(nl + 1).trim();
    }
  }
  return text;
}

export function jsonForPrompt(payload: Record<string, unknown>, limit = 120_000): string {
  let text = JSON.stringify(payload);
  text = redactSecrets(text);
  if (text.length <= limit) return text;
  const head = Math.max(1, Math.floor(limit / 2));
  const tail = Math.max(1, limit - head - 80);
  return text.slice(0, head) + "\n...[memory prompt truncated]...\n" + text.slice(-tail);
}

export function redactSecrets(text: string): string {
  let redacted = text.replace(
    /(api[_-]?key|secret|token|password|passphrase|authorization|cookie)("?\s*[:=]\s*"?)[^",}\s]+/gi,
    "$1$2[REDACTED_SECRET]",
  );
  redacted = redacted.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/g, "Bearer [REDACTED_SECRET]");
  return redacted;
}

export function readTextIfExists(filePath: string, limit = 80_000): string {
  try {
    const content = fs.readFileSync(filePath, "utf8");
    if (content.length <= limit) return content;
    const half = Math.floor(limit / 2);
    return content.slice(0, half) + "\n...[file truncated]...\n" + content.slice(-half);
  } catch {
    return "";
  }
}

export function readMarkdownTree(
  root: string,
  opts: { fileLimit?: number; charLimit?: number } = {},
): Array<{ path: string; content: string }> {
  const fileLimit = opts.fileLimit ?? 80;
  const charLimit = opts.charLimit ?? 120_000;
  if (!fs.existsSync(root)) return [];
  const entries: Array<{ path: string; content: string }> = [];
  let totalChars = 0;
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entries.length >= fileLimit) return;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!entry.name.endsWith(".md")) continue;
      const content = readTextIfExists(full, 20_000);
      if (totalChars + content.length > charLimit) return;
      entries.push({ path: path.relative(path.dirname(root), full).replace(/\\/g, "/"), content });
      totalChars += content.length;
    }
  };
  walk(root);
  return entries;
}

export function clipText(text: string, limit: number): string {
  const content = text.replace(/\s+/g, " ").trim();
  return content.length <= limit ? content : content.slice(0, limit - 3) + "...";
}

export function formatNumber(value: number): string {
  const text = value.toFixed(8).replace(/0+$/, "").replace(/\.$/, "");
  return text || "0";
}

export function formatOptionalNumber(value: number | null | undefined): string {
  return value == null ? "n/a" : formatNumber(value);
}

export function formatTimestampMs(timestampMs: number): string {
  return new Date(timestampMs).toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function filenameTimestamp(timestampMs: number): string {
  const d = new Date(timestampMs);
  const pad2 = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}-${pad2(d.getUTCHours())}${pad2(d.getUTCMinutes())}${pad2(d.getUTCSeconds())}`;
}

export function isoToMs(isoValue: string): number {
  return new Date(isoValue.replace("Z", "+00:00")).getTime();
}

export function tradeSlug(instrumentKey: string, exitKind: string, realizedPnl: number): string {
  const parts = instrumentKey.split(":");
  const symbol = parts.length >= 3 ? parts[parts.length - 2] : instrumentKey;
  const direction = realizedPnl >= 0 ? "profit" : "loss";
  return cleanToken(`${symbol}-${exitKind}-${direction}`, "trade") ?? "trade";
}

export function exitFillKind(fills: Fill[] | readonly Fill[]): string {
  for (let i = fills.length - 1; i >= 0; i--) {
    const kind = fills[i].kind;
    if (kind === FillKind.STOP || kind === FillKind.TARGET || kind === FillKind.EXIT) {
      return kind;
    }
  }
  return "closed";
}

export function extractPreferenceSignals(messages: string[]): string[] {
  const signals: string[] = [];
  for (const message of messages) {
    const compact = message.replace(/\s+/g, " ").trim();
    if (["不要", "别", "不要自动", "先不要"].some((term) => compact.includes(term))) {
      signals.push(clipText(compact, 120));
    }
  }
  return [...new Map(signals.map((s) => [s, s])).values()];
}

export function extractPreferenceSignalsFromOutputs(outputs: Stage1Output[]): string[] {
  const items: string[] = [];
  for (const output of outputs) {
    for (const line of output.rawMemory.split("\n")) {
      const stripped = line.trim();
      if (stripped.startsWith("- ") && ["不要", "别", "prefer", "偏好"].some((t) => stripped.includes(t))) {
        items.push(stripped.slice(2));
      }
    }
  }
  return [...new Map(items.map((s) => [s, s])).values()];
}

export function keywordsForOutput(output: Stage1Output): string[] {
  const keywords: string[] = [output.source.sourceType];
  if (output.source.sourceType === SOURCE_TRADE_EVENT) {
    keywords.push(`trade_id=${output.source.sourceRef}`);
  }
  const matches = output.rolloutSummary.match(/[A-Za-z0-9:_-]{4,}/g) ?? [];
  keywords.push(...matches);
  const cleaned = [...new Map(keywords.filter(Boolean).map((k) => [k, k])).values()];
  return cleaned.slice(0, 8);
}

export function groupOutputs(outputs: Stage1Output[]): Array<[string, Stage1Output[]]> {
  const grouped: Record<string, Stage1Output[]> = {
    "Agent Sessions": [],
    "Closed Trades": [],
    "Manual Notes": [],
  };
  for (const output of outputs) {
    if (output.source.sourceType === SOURCE_AGENT_SESSION) grouped["Agent Sessions"].push(output);
    else if (output.source.sourceType === SOURCE_TRADE_EVENT) grouped["Closed Trades"].push(output);
    else if (output.source.sourceType === SOURCE_MANUAL_NOTE) grouped["Manual Notes"].push(output);
  }
  return Object.entries(grouped).filter(([, items]) => items.length > 0);
}

export function uniqueStrings(values: Iterable<unknown>): string[] {
  const items: string[] = [];
  for (const value of values) {
    const text = String(value).trim();
    if (text) items.push(text);
  }
  return [...new Map(items.map((s) => [s, s])).values()];
}

const GENERATED_MEMORY_PATH_RE = /(?:facts|reviews|rollout_summaries)\/[A-Za-z0-9_./:-]+\.md/g;

export function removeStaleGeneratedReferences(content: string, root: string): string {
  const lines = content.split(/(?<=\n)/);
  if (lines.length === 0) return content;
  const output: string[] = [];
  let block: string[] = [];
  let blockIsTask = false;

  const flush = () => {
    if (block.length === 0) return;
    const blockText = block.join("");
    if (blockIsTask && containsStaleGeneratedReference(blockText, root)) {
      block = [];
      blockIsTask = false;
      return;
    }
    for (const line of block) {
      if (containsStaleGeneratedReference(line, root)) continue;
      output.push(line);
    }
    block = [];
    blockIsTask = false;
  };

  for (const line of lines) {
    if (line.startsWith("## ")) {
      flush();
      blockIsTask = line.startsWith("## Task ");
      block = [line];
      continue;
    }
    block.push(line);
  }
  flush();

  let result = output.join("");
  if (content.endsWith("\n") && result && !result.endsWith("\n")) result += "\n";
  return result;
}

export function containsStaleGeneratedReference(text: string, root: string): boolean {
  GENERATED_MEMORY_PATH_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = GENERATED_MEMORY_PATH_RE.exec(text)) !== null) {
    if (!fs.existsSync(path.join(root, match[0]))) return true;
  }
  return false;
}

export function factSummaryFromMarkdown(content: string): string {
  for (const line of content.split("\n")) {
    if (line.startsWith("事实摘要：")) return line.replace("事实摘要：", "").trim();
  }
  return "";
}
