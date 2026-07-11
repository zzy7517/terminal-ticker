import type { AgentConfig } from "../../config/index.js";
import type { Usage } from "@earendil-works/pi-ai";
import { nowMs } from "../../db.js";
import type { LLMChatClient } from "../../agent/llm_client.js";
import { TradeStatus, fillToPayload, tradeToPayload, snapshotToPayload } from "../../trading/models.js";
import type { TradeStore } from "../../trading/store.js";
import {
  DEFAULT_RETRY_DELAY_MS,
  type MemoryStateStore,
  SOURCE_AGENT_SESSION,
  SOURCE_MANUAL_NOTE,
  SOURCE_TRADE_EVENT,
  type Stage1Job,
} from "../state.js";
import {
  MANUAL_NOTE_DIRNAME,
  LEGACY_MANUAL_NOTE_DIRNAME,
  cleanToken,
  clipText,
  exitFillKind,
  extractPreferenceSignals,
  formatNumber,
  formatOptionalNumber,
  isoToMs,
  jsonForPrompt,
  parseJsonObject,
  promptCharLimitForModel,
  redactSecrets,
  redactStructuredValue,
  tradeSlug,
} from "./renderers.js";
import { elapsedMs, memoryLog, usageFields } from "../telemetry.js";
import fs from "node:fs";
import path from "node:path";
import { averageEntryPrice, averageExitPrice } from "../../trading/models.js";

export const PHASE1_SYSTEM_PROMPT = `You are the tradex Memory Writing Agent, Phase 1.

Extract high-signal memory from exactly one source. Output strict JSON only:
{"rollout_summary": string, "rollout_slug": string|null, "raw_memory": string}

High-signal memory includes:
1. Stable user preferences and repeated corrections.
2. Reusable workflow knowledge, exact paths, commands, and failure shields.
3. Reliable task maps and long-lived environment facts.
4. Closed-trade facts, while keeping causal review/hypothesis separate.

No-op / minimum signal gate:
- Before writing memory, ask: "Will a future tradex agent plausibly act better because this exists?"
- If the answer is no, return exactly {"rollout_summary":"","rollout_slug":null,"raw_memory":""}.
- Prefer no-op for one-off market state, generic status updates, obvious facts, transient news, or recaps with no reusable lesson.

Task outcome triage:
- Mark task_outcome as success, partial, failed, uncertain, or observed.
- Use success/partial/failed/uncertain for agent-session work.
- Use observed for structured trade exports and manual notes unless the source itself contains a reviewed outcome.

Reading priority:
- User corrections, repeated preferences, and explicit constraints are strongest evidence.
- Exact commands, paths, config keys, provider names, instrument keys, and error snippets are valuable when reusable.
- Tool outputs and assistant claims are evidence only when tied to what happened in the source; never promote them into verified facts without support.

Rules:
- User messages are stronger evidence than assistant messages.
- No-op is better than low-signal memory: return empty strings when nothing should persist.
- raw_memory should use task blocks with task_outcome, Preference signals, Reusable knowledge, Failures and how to do differently, and References when applicable.
- Keep raw_memory compact. Preserve searchable exact terms, not long transcript copies.
- For trade facts, record only observed fields. Do not write causal language such as because, caused, likely, should, 因为, 导致, 应该, 倾向.
- If the source contains review lessons or hypotheses, label them as hypotheses and keep them separate from observed facts.
- Do not store secrets. Replace tokens, keys, passwords, cookies, and auth headers with [REDACTED_SECRET].
`;

export interface Phase1Extraction {
  rolloutSummary: string;
  rolloutSlug: string | null;
  rawMemory: string;
}

export interface Phase1ProcessResult {
  sourceId: number;
  sourceType: string;
  sourceRef: string;
  status: "succeeded" | "succeeded_no_output" | "failed" | "lost_lease";
  durationMs: number;
  total_tokens?: number;
  input_tokens?: number;
  output_tokens?: number;
  cache_read_tokens?: number;
  cache_write_tokens?: number;
  error?: string;
}

export function manualNotePath(root: string, noteRef: string, mustExist = false): string {
  const primary = path.join(root, MANUAL_NOTE_DIRNAME, `${noteRef}.json`);
  if (!mustExist || fs.existsSync(primary)) return primary;
  const legacy = path.join(root, LEGACY_MANUAL_NOTE_DIRNAME, `${noteRef}.json`);
  return fs.existsSync(legacy) ? legacy : primary;
}

export function normalizePhase1Output(payload: string | Record<string, unknown>): Phase1Extraction {
  const parsed: Record<string, unknown> = typeof payload === "string" ? (JSON.parse(payload) as Record<string, unknown>) : payload;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("phase1 output must be a JSON object");
  }
  const expectedKeys = new Set(["rollout_summary", "rollout_slug", "raw_memory"]);
  const actualKeys = new Set(Object.keys(parsed));
  const extra = [...actualKeys].filter((k) => !expectedKeys.has(k));
  const missing = [...expectedKeys].filter((k) => !actualKeys.has(k));
  if (extra.length > 0 || missing.length > 0) {
    const details: string[] = [];
    if (missing.length) details.push(`missing keys: ${JSON.stringify(missing.sort())}`);
    if (extra.length) details.push(`extra keys: ${JSON.stringify(extra.sort())}`);
    throw new Error("phase1 output must match the strict schema: " + details.join("; "));
  }
  if (typeof parsed.rollout_summary !== "string") throw new Error("phase1 rollout_summary must be a string");
  if (parsed.rollout_slug !== null && typeof parsed.rollout_slug !== "string") throw new Error("phase1 rollout_slug must be a string or null");
  if (typeof parsed.raw_memory !== "string") throw new Error("phase1 raw_memory must be a string");

  const rolloutSummary = redactSecrets(String(parsed.rollout_summary ?? "")).trim();
  const rolloutSlugRaw = parsed.rollout_slug;
  const rolloutSlug = rolloutSlugRaw ? cleanToken(rolloutSlugRaw, null) : null;
  const rawMemory = redactSecrets(String(parsed.raw_memory ?? "")).trim();
  return { rolloutSummary, rolloutSlug, rawMemory };
}

export type LLMProviderFactory = (config: AgentConfig) => LLMChatClient;

export interface SessionSource {
  listSessions(input: { limit?: number }): Array<{ id: string; updatedAt: string; messageCount: number }>;
  sessionPayload(sessionId: string): Record<string, unknown> | null;
}

interface FilteredSessionMessage {
  role: string;
  content: string;
  created_at: unknown;
  error: unknown;
}

function matchesMarkedFragment(text: string, startMarker: string, endMarker: string): boolean {
  const startTrimmed = text.trimStart();
  const endTrimmed = text.trimEnd();
  return startTrimmed.toLowerCase().startsWith(startMarker.toLowerCase()) &&
    endTrimmed.toLowerCase().endsWith(endMarker.toLowerCase());
}

function isMemoryExcludedContextualFragment(content: string): boolean {
  return (
    matchesMarkedFragment(content, "# AGENTS.md instructions for ", "</INSTRUCTIONS>") ||
    matchesMarkedFragment(content, "<skill>", "</skill>") ||
    matchesMarkedFragment(content, "<system_reminder>", "</system_reminder>") ||
    matchesMarkedFragment(content, "<environment_context>", "</environment_context>")
  );
}

function filteredAgentSessionMessages(payload: Record<string, unknown>): FilteredSessionMessage[] {
  const messages = payload.messages as Array<Record<string, unknown>> | undefined;
  return (messages ?? [])
    .filter((item) => typeof item === "object" && item && ["user", "assistant", "tool"].includes(String(item.role ?? "")))
    .map((item) => ({
      role: String(item.role ?? ""),
      content: String(item.content ?? ""),
      created_at: item.createdAt ?? item.created_at,
      error: item.error ?? null,
    }))
    .filter((item) => item.role !== "user" || !isMemoryExcludedContextualFragment(item.content));
}

const EXTERNAL_CONTEXT_TOOL_NAMES = new Set([
  "web_search",
  "web_fetch",
  "get_recent_news",
  "refresh_news",
  "refresh_x_following_feed",
  "get_recent_social_feed",
  "search_x_tweets",
  "browser_open_page",
  "browser_screenshot",
  "browser_status",
]);

function toolNamePollutesMemory(toolName: unknown): boolean {
  const name = String(toolName ?? "").trim();
  return Boolean(name && (EXTERNAL_CONTEXT_TOOL_NAMES.has(name) || name.startsWith("mcp:")));
}

function sessionHasExternalContext(payload: Record<string, unknown>): boolean {
  const session = payload.session && typeof payload.session === "object" && !Array.isArray(payload.session)
    ? payload.session as Record<string, unknown>
    : {};
  const memory = session.memory && typeof session.memory === "object" && !Array.isArray(session.memory)
    ? session.memory as Record<string, unknown>
    : {};
  if (memory.externalContext === true || session.memoryExternalContext === true) return true;

  const messages = payload.messages as Array<Record<string, unknown>> | undefined;
  for (const message of messages ?? []) {
    const metadata = message.metadata && typeof message.metadata === "object" && !Array.isArray(message.metadata)
      ? message.metadata as Record<string, unknown>
      : {};
    if (toolNamePollutesMemory(metadata.toolName)) return true;
    const toolCalls = Array.isArray(metadata.toolCalls) ? metadata.toolCalls : [];
    for (const toolCall of toolCalls) {
      if (toolCall && typeof toolCall === "object" && toolNamePollutesMemory((toolCall as Record<string, unknown>).name)) {
        return true;
      }
    }
  }
  return false;
}

export class Phase1Processor {
  readonly root: string;
  readonly stateStore: MemoryStateStore;
  readonly sessionSource: SessionSource;
  readonly tradeStore: TradeStore;
  readonly agentConfigProvider: (() => AgentConfig | null) | null;
  readonly llmProviderFactory: LLMProviderFactory;
  readonly startupScanLimit: number;
  readonly maxSourceAgeDays: number;
  readonly minAgentSessionIdleHours: number;
  readonly disableOnExternalContext: boolean;

  constructor(input: {
    root: string;
    stateStore: MemoryStateStore;
    sessionSource: SessionSource;
    tradeStore: TradeStore;
    agentConfigProvider: (() => AgentConfig | null) | null;
    llmProviderFactory: LLMProviderFactory;
    startupScanLimit: number;
    maxSourceAgeDays: number;
    minAgentSessionIdleHours: number;
    disableOnExternalContext?: boolean;
  }) {
    this.root = input.root;
    this.stateStore = input.stateStore;
    this.sessionSource = input.sessionSource;
    this.tradeStore = input.tradeStore;
    this.agentConfigProvider = input.agentConfigProvider;
    this.llmProviderFactory = input.llmProviderFactory;
    this.startupScanLimit = input.startupScanLimit;
    this.maxSourceAgeDays = input.maxSourceAgeDays;
    this.minAgentSessionIdleHours = input.minAgentSessionIdleHours;
    this.disableOnExternalContext = input.disableOnExternalContext ?? false;
  }

  async scanStartupSources(): Promise<void> {
    const at = nowMs();
    const maxAgeMs = this.maxSourceAgeDays * 86_400_000;
    const cutoff = maxAgeMs ? at - maxAgeMs : null;
    const minSessionIdleMs = this.minAgentSessionIdleHours * 3_600_000;
    let queued = 0;

    const sessions = this.sessionSource.listSessions({ limit: this.startupScanLimit });
    for (const summary of sessions) {
      if (queued >= this.startupScanLimit) break;
      const updatedAt = isoToMs(summary.updatedAt);
      if (cutoff != null && updatedAt < cutoff) continue;
      if (minSessionIdleMs && at - updatedAt < minSessionIdleMs) continue;
      if (summary.messageCount <= 0) continue;
      if (this.disableOnExternalContext && this._agentSessionHasExternalContext(summary.id)) continue;
      this.stateStore.enqueueSource({
        sourceType: SOURCE_AGENT_SESSION,
        sourceRef: summary.id,
        updatedAt,
      });
      queued += 1;
    }

    const remaining = Math.max(0, this.startupScanLimit - queued);
    if (remaining === 0) return;
    const closed = this.tradeStore.listTrades({ statuses: [TradeStatus.CLOSED], limit: remaining });
    for (const trade of closed) {
      if (cutoff != null && trade.updatedAtMs < cutoff) continue;
      this.stateStore.enqueueSource({
        sourceType: SOURCE_TRADE_EVENT,
        sourceRef: String(trade.id),
        updatedAt: trade.updatedAtMs,
      });
      queued += 1;
      if (queued >= this.startupScanLimit) break;
    }
  }

  async processJob(job: Stage1Job): Promise<Phase1ProcessResult> {
    const startedAt = Date.now();
    const base = {
      sourceId: job.sourceId,
      sourceType: job.source.sourceType,
      sourceRef: job.source.sourceRef,
    };
    try {
      const agentConfig = this.agentConfigProvider?.() ?? null;
      let extraction: Phase1Extraction;
      let tokenUsage: Record<string, number> = {};

      if (this.agentConfigProvider != null) {
        if (!agentConfig?.enabled) throw new Error("memory Phase 1 requires an enabled agent model configuration");
        const payload = this._serializeSourceForLlm(job);
        const result = await this._extractWithLlm(job, payload, agentConfig);
        extraction = result.extraction;
        tokenUsage = usageFields(result.usage);
      } else {
        const payload = this._serializeSource(job);
        extraction = normalizePhase1Output(payload);
      }

      if (!extraction.rawMemory.trim() || !extraction.rolloutSummary.trim()) {
        const updated = this.stateStore.markStage1NoOutput({ sourceId: job.sourceId, ownershipToken: job.ownershipToken });
        const status = updated ? "succeeded_no_output" : "lost_lease";
        const result = { ...base, status, durationMs: elapsedMs(startedAt), ...tokenUsage } as Phase1ProcessResult;
        memoryLog(updated ? "info" : "warn", "phase1_job_finished", result);
        return result;
      }
      const updated = this.stateStore.markStage1Succeeded({
        sourceId: job.sourceId,
        ownershipToken: job.ownershipToken,
        rawMemory: extraction.rawMemory,
        rolloutSummary: extraction.rolloutSummary,
        rolloutSlug: extraction.rolloutSlug,
      });
      const status = updated ? "succeeded" : "lost_lease";
      const result = { ...base, status, durationMs: elapsedMs(startedAt), ...tokenUsage } as Phase1ProcessResult;
      memoryLog(updated ? "info" : "warn", "phase1_job_finished", result);
      return result;
    } catch (exc) {
      const error = exc instanceof Error ? exc.message : String(exc);
      const updated = this.stateStore.markStage1Failed({
        sourceId: job.sourceId,
        ownershipToken: job.ownershipToken,
        error,
        retryDelayMs: DEFAULT_RETRY_DELAY_MS,
      });
      const result: Phase1ProcessResult = {
        ...base,
        status: updated ? "failed" : "lost_lease",
        durationMs: elapsedMs(startedAt),
        error,
      };
      memoryLog("error", "phase1_job_finished", result);
      return result;
    }
  }

  private async _extractWithLlm(
    job: Stage1Job,
    payload: Record<string, unknown>,
    agentConfig: AgentConfig,
  ): Promise<{ extraction: Phase1Extraction; usage: Usage }> {
    const provider = this.llmProviderFactory(agentConfig);
    const userPayload = {
      source_id: job.sourceId,
      source_type: job.source.sourceType,
      source_ref: job.source.sourceRef,
      source_updated_at: job.source.updatedAt,
      payload,
    };
    const promptLimit = promptCharLimitForModel({
      provider: agentConfig.provider,
      model: agentConfig.model,
      contextPercent: 0.7,
      reservedTokens: 6_000,
      fallbackTokens: 128_000,
    });
    const response = await provider.chat({
      system: PHASE1_SYSTEM_PROMPT,
      messages: [
        { role: "user", content: jsonForPrompt(userPayload, promptLimit), timestamp: Date.now() },
      ],
    });
    return { extraction: normalizePhase1Output(parseJsonObject(response.content)), usage: response.message.usage };
  }

  private _serializeSourceForLlm(job: Stage1Job): Record<string, unknown> {
    const source = job.source;
    if (source.sourceType === SOURCE_AGENT_SESSION) return this._agentSessionLlmPayload(source.sourceRef);
    if (source.sourceType === SOURCE_TRADE_EVENT) return this._tradeEventLlmPayload(source.sourceRef);
    if (source.sourceType === SOURCE_MANUAL_NOTE) return this._manualNoteLlmPayload(source.sourceRef);
    throw new Error(`unsupported memory source_type: ${source.sourceType}`);
  }

  private _serializeSource(job: Stage1Job): Record<string, unknown> {
    const source = job.source;
    if (source.sourceType === SOURCE_AGENT_SESSION) return this._extractAgentSession(source.sourceRef);
    if (source.sourceType === SOURCE_TRADE_EVENT) return this._extractTradeEvent(source.sourceRef);
    if (source.sourceType === SOURCE_MANUAL_NOTE) return this._extractManualNote(source.sourceRef);
    throw new Error(`unsupported memory source_type: ${source.sourceType}`);
  }

  private _agentSessionLlmPayload(sessionId: string): Record<string, unknown> {
    const payload = this.sessionSource.sessionPayload(sessionId);
    if (!payload) throw new Error(`agent session not found: ${sessionId}`);
    if (this.disableOnExternalContext && sessionHasExternalContext(payload as Record<string, unknown>)) {
      return { session: (payload as Record<string, unknown>).session, messages: [], skipped: "external_context" };
    }
    const filtered = filteredAgentSessionMessages(payload as Record<string, unknown>);
    return redactStructuredValue({ session: (payload as Record<string, unknown>).session, messages: filtered });
  }

  private _tradeEventLlmPayload(tradeRef: string): Record<string, unknown> {
    const trade = this.tradeStore.getTrade(parseInt(tradeRef, 10));
    if (!trade) throw new Error(`trade not found: ${tradeRef}`);
    const snapshot = trade.snapshotId ? this.tradeStore.getSnapshot(trade.snapshotId) : null;
    return redactStructuredValue({
      trade: tradeToPayload(trade),
      snapshot: snapshot ? snapshotToPayload(snapshot) : null,
      fills: trade.fills.map(fillToPayload),
    });
  }

  private _manualNoteLlmPayload(noteRef: string): Record<string, unknown> {
    const notePath = manualNotePath(this.root, noteRef, true);
    if (!fs.existsSync(notePath)) throw new Error(`manual note not found: ${noteRef}`);
    return redactStructuredValue(JSON.parse(fs.readFileSync(notePath, "utf8")) as Record<string, unknown>);
  }

  private _extractAgentSession(sessionId: string): Record<string, unknown> {
    const payload = this.sessionSource.sessionPayload(sessionId);
    if (!payload) throw new Error(`agent session not found: ${sessionId}`);
    if (this.disableOnExternalContext && sessionHasExternalContext(payload as Record<string, unknown>)) {
      return { rollout_summary: "", rollout_slug: null, raw_memory: "" };
    }
    const messages = filteredAgentSessionMessages(payload as Record<string, unknown>);
    const userMessages = messages
      .filter((m) => m.role === "user" && String(m.content ?? "").trim())
      .map((m) => String(m.content ?? "").trim());
    const assistantMessages = messages
      .filter((m) => m.role === "assistant" && String(m.content ?? "").trim())
      .map((m) => String(m.content ?? "").trim());

    if (!userMessages.length && !assistantMessages.length) {
      return { rollout_summary: "", rollout_slug: null, raw_memory: "" };
    }
    const firstUser = userMessages[0] ?? "用户未留下可用输入";
    const latestAssistant = assistantMessages[assistantMessages.length - 1] ?? "";
    const preview = clipText(firstUser, 80);
    let summary = `Agent session ${sessionId} 记录了用户请求：${preview}。`;
    if (latestAssistant) summary += ` 最后一次助手响应为：${clipText(latestAssistant, 80)}。`;

    const rawLines = [
      "### Task 1: Agent session transcript",
      "task_outcome: observed",
      "Preference signals:",
    ];
    const preferenceSignals = extractPreferenceSignals(userMessages);
    if (preferenceSignals.length) {
      rawLines.push(...preferenceSignals.map((item) => `- ${item}`));
    } else {
      rawLines.push("- 暂无稳定偏好，仅保留会话请求。");
    }
    rawLines.push("Reusable knowledge:", `- 首条用户请求：${preview}`);
    if (latestAssistant) rawLines.push(`- 最近助手输出：${clipText(latestAssistant, 120)}`);
    rawLines.push("References:", `- session_id=${sessionId}`, `- message_count=${messages.length}`);

    return {
      rollout_summary: summary,
      rollout_slug: `agent-session-${sessionId.slice(0, 8)}`,
      raw_memory: rawLines.join("\n"),
    };
  }

  private _agentSessionHasExternalContext(sessionId: string): boolean {
    const payload = this.sessionSource.sessionPayload(sessionId);
    return Boolean(payload && sessionHasExternalContext(payload as Record<string, unknown>));
  }

  private _extractTradeEvent(tradeRef: string): Record<string, unknown> {
    const trade = this.tradeStore.getTrade(parseInt(tradeRef, 10));
    if (!trade) throw new Error(`trade not found: ${tradeRef}`);
    if (trade.status !== TradeStatus.CLOSED) {
      return { rollout_summary: "", rollout_slug: null, raw_memory: "" };
    }
    const fills = trade.fills;
    const exitKind = exitFillKind(fills);
    const pnlText = formatNumber(trade.realizedPnl);
    const summary = `${trade.instrumentKey} ${trade.direction} trade closed. realized_pnl=${pnlText}, exit=${exitKind}, size=${formatNumber(trade.size)}.`;
    const rawLines = [
      "### Task 1: Closed trade export",
      "task_outcome: observed",
      "Reusable knowledge:",
      `- instrument_key=${trade.instrumentKey}`,
      `- direction=${trade.direction}`,
      `- status=${trade.status}`,
      `- size=${formatNumber(trade.size)}`,
      `- realized_pnl=${pnlText}`,
      `- fill_count=${fills.length}`,
      `- average_entry_price=${formatOptionalNumber(averageEntryPrice(trade))}`,
      `- average_exit_price=${formatOptionalNumber(averageExitPrice(trade))}`,
    ];
    if (trade.intentPrice != null) rawLines.push(`- intent_price=${formatNumber(trade.intentPrice)}`);
    if (trade.stopPrice != null) rawLines.push(`- stop_price=${formatNumber(trade.stopPrice)}`);
    if (trade.targetPrices.length) {
      rawLines.push("- target_prices=" + trade.targetPrices.map(formatNumber).join(","));
    }
    if (fills.length) {
      rawLines.push("- fills:");
      for (const fill of fills) {
        rawLines.push(`  - ${fill.kind}@${formatNumber(fill.price)} x ${formatNumber(fill.quantity)} reason=${fill.triggerReason || "n/a"}`);
      }
    }
    if (trade.snapshotId != null) rawLines.push(`- snapshot_id=${trade.snapshotId}`);
    rawLines.push("References:", `- trade_id=${trade.id}`, `- session_id=${trade.sessionId ?? "n/a"}`, `- snapshot_id=${trade.snapshotId ?? "n/a"}`);

    return {
      rollout_summary: summary,
      rollout_slug: tradeSlug(trade.instrumentKey, exitKind, trade.realizedPnl),
      raw_memory: rawLines.join("\n"),
    };
  }

  private _extractManualNote(noteRef: string): Record<string, unknown> {
    const notePath = manualNotePath(this.root, noteRef, true);
    if (!fs.existsSync(notePath)) throw new Error(`manual note not found: ${noteRef}`);
    const payload = redactStructuredValue(JSON.parse(fs.readFileSync(notePath, "utf8")) as Record<string, unknown>);
    if (["rollout_summary", "rollout_slug", "raw_memory"].every((k) => k in payload)) {
      return { rollout_summary: payload.rollout_summary, rollout_slug: payload.rollout_slug, raw_memory: payload.raw_memory };
    }
    const text = String(payload.text ?? payload.note ?? "").trim();
    if (!text) return { rollout_summary: "", rollout_slug: null, raw_memory: "" };
    return {
      rollout_summary: clipText(text, 140),
      rollout_slug: noteRef,
      raw_memory: [
        "### Task 1: Manual note",
        "task_outcome: observed",
        "Reusable knowledge:",
        `- ${text}`,
        "References:",
        `- manual_note=${noteRef}`,
      ].join("\n"),
    };
  }
}
