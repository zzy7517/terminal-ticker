import type { AgentConfig, MemoryConfig } from "../config/index.js";
import type { ChatResponse, LLMChatClient } from "../agent/llm_client.js";
import {
  agentConfigForModelSelection,
  type ModelRuntimeSnapshot,
} from "../agent/model_runtime.js";
import type { TradeStore } from "../trading/store.js";
import { ensureMemoryLayout } from "./paths.js";
import { MemoryRuntimePolicy } from "./policy.js";
import {
  DEFAULT_MAX_UNUSED_DAYS,
  DEFAULT_PRUNE_BATCH_SIZE,
  MemoryStateStore,
  SOURCE_MANUAL_NOTE,
  SOURCE_TRADE_EVENT,
} from "./state.js";
import { MemoryFileStorage } from "./write/storage.js";
import { Phase1Processor, type LLMProviderFactory, type SessionSource } from "./write/phase1.js";
import { Phase2Runner } from "./write/phase2.js";
import { elapsedMs, memoryLog } from "./telemetry.js";

const STAGE1_CONCURRENCY = 4;
const DEFAULT_PHASE2_HEARTBEAT_MS = 90_000;
const DEFAULT_STARTUP_SCAN_LIMIT = 5_000;
const DEFAULT_MAX_SOURCE_AGE_DAYS = 180;
const DEFAULT_MIN_AGENT_SESSION_IDLE_HOURS = 12;
const DEFAULT_EXTENSION_RETENTION_DAYS = 7;
const DEFAULT_RATE_LIMIT_COOLDOWN_MS = 15 * 60_000;
const DEFAULT_REQUEST_WINDOW_MS = 60_000;
const DEFAULT_MAX_MEMORY_REQUESTS_PER_WINDOW = 16;

type ChatInput = Parameters<LLMChatClient["chat"]>[0];

export class MemoryRateLimitGuard {
  private readonly cooldownMs: number;
  private readonly requestWindowMs: number;
  private readonly maxRequestsPerWindow: number;
  private readonly requestTimestamps: number[] = [];
  private blockedUntilMs = 0;

  constructor(input: {
    cooldownMs?: number;
    requestWindowMs?: number;
    maxRequestsPerWindow?: number;
  } = {}) {
    this.cooldownMs = input.cooldownMs ?? DEFAULT_RATE_LIMIT_COOLDOWN_MS;
    this.requestWindowMs = input.requestWindowMs ?? DEFAULT_REQUEST_WINDOW_MS;
    this.maxRequestsPerWindow = input.maxRequestsPerWindow ?? DEFAULT_MAX_MEMORY_REQUESTS_PER_WINDOW;
  }

  canRun(now = Date.now()): { ok: true } | { ok: false; reason: string } {
    this.prune(now);
    if (now < this.blockedUntilMs) {
      return { ok: false, reason: `rate-limit cooldown active until ${new Date(this.blockedUntilMs).toISOString()}` };
    }
    if (this.requestTimestamps.length >= this.maxRequestsPerWindow) {
      return { ok: false, reason: `memory LLM request budget exhausted in the last ${this.requestWindowMs / 1000}s` };
    }
    return { ok: true };
  }

  reserveRequest(now = Date.now()): { ok: true } | { ok: false; reason: string } {
    const allowed = this.canRun(now);
    if (!allowed.ok) return allowed;
    this.requestTimestamps.push(now);
    return { ok: true };
  }

  noteError(error: unknown): void {
    if (this.isRateLimitError(error)) {
      this.blockedUntilMs = Date.now() + this.cooldownMs;
    }
  }

  async chat(provider: LLMChatClient, input: ChatInput): Promise<ChatResponse> {
    const allowed = this.reserveRequest();
    if (!allowed.ok) throw new Error(`memory rate-limit guard skipped LLM request: ${allowed.reason}`);

    try {
      return await provider.chat(input);
    } catch (error) {
      this.noteError(error);
      throw error;
    }
  }

  private prune(now: number): void {
    const cutoff = now - this.requestWindowMs;
    while (this.requestTimestamps.length > 0 && this.requestTimestamps[0] < cutoff) {
      this.requestTimestamps.shift();
    }
  }

  private isRateLimitError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return /\b429\b|rate.?limit|usage.?limit|too many requests/i.test(message);
  }
}

export class MemoryPipeline {
  readonly root: string;
  readonly config: MemoryConfig;
  readonly policy: MemoryRuntimePolicy;
  readonly state: MemoryStateStore;
  readonly storage: MemoryFileStorage;
  readonly phase1: Phase1Processor;
  readonly phase2: Phase2Runner;
  private readonly rateLimitGuard = new MemoryRateLimitGuard();
  private _startupPromise: Promise<void> | null = null;

  constructor(input: {
    config: MemoryConfig;
    state?: MemoryStateStore;
    sessionSource?: SessionSource;
    tradeStore?: TradeStore;
    agentConfigProvider?: (() => AgentConfig | null) | null;
    phase2ConfigProvider?: (() => AgentConfig | null) | null;
    llmProviderFactory?: LLMProviderFactory;
    modelRuntimeSnapshot?: ModelRuntimeSnapshot;
    policy?: MemoryRuntimePolicy;
  }) {
    this.config = input.config;
    this.root = ensureMemoryLayout(input.config.storagePath);
    this.policy = input.policy ?? MemoryRuntimePolicy.normal();
    this.state = input.state ?? new MemoryStateStore();

    const tradeStore = input.tradeStore;
    const sessionSource: SessionSource = input.sessionSource ?? { listSessions: () => [], sessionPayload: () => null };
    const agentConfigProvider = input.agentConfigProvider ?? null;
    const phase1AgentConfigProvider = agentConfigProvider
      ? (() => {
          const config = agentConfigProvider();
          return config
            ? agentConfigForModelSelection(config, input.config.extractModel)
            : config;
        })
      : null;
    const llmProviderFactory = input.llmProviderFactory ?? (() => { throw new Error("no LLM provider factory configured"); }) as unknown as LLMProviderFactory;
    const guardedLlmProviderFactory: LLMProviderFactory = (agentConfig) => {
      const provider = llmProviderFactory(agentConfig);
      return {
        name: provider.name,
        model: provider.model,
        chat: (chatInput) => this.rateLimitGuard.chat(provider, chatInput),
      };
    };
    this.storage = new MemoryFileStorage({
      root: this.root,
      tradeStore: tradeStore ?? ({ getTrade: () => null, getSnapshot: () => null, listTrades: () => [], listLessons: () => [] } as unknown as TradeStore),
      extensionRetentionDays: input.config.extensionRetentionDays ?? DEFAULT_EXTENSION_RETENTION_DAYS,
    });

    this.phase1 = new Phase1Processor({
      root: this.root,
      stateStore: this.state,
      sessionSource,
      tradeStore: tradeStore ?? ({ listTrades: () => [], getTrade: () => null, getSnapshot: () => null } as unknown as TradeStore),
      agentConfigProvider: phase1AgentConfigProvider,
      llmProviderFactory: guardedLlmProviderFactory,
      startupScanLimit: input.config.maxRolloutsPerStartup ?? DEFAULT_STARTUP_SCAN_LIMIT,
      maxSourceAgeDays: input.config.maxSourceAgeDays ?? DEFAULT_MAX_SOURCE_AGE_DAYS,
      minAgentSessionIdleHours: input.config.minSessionIdleHours ?? DEFAULT_MIN_AGENT_SESSION_IDLE_HOURS,
      disableOnExternalContext: input.config.disableOnExternalContext,
    });

    this.phase2 = new Phase2Runner({
      root: this.root,
      stateStore: this.state,
      storage: this.storage,
      agentConfigProvider: input.phase2ConfigProvider ?? agentConfigProvider,
      rateLimitGuard: this.rateLimitGuard,
      consolidationModel: input.config.consolidationModel,
      modelRuntimeSnapshot: input.modelRuntimeSnapshot,
      heartbeatIntervalMs: DEFAULT_PHASE2_HEARTBEAT_MS,
    });
  }

  kickoffStartup(): void {
    if (!this.policy.generateMemories) return;
    if (this._startupPromise != null) return;
    this._startupPromise = this._runStartup();
  }

  async shutdown(): Promise<void> {
    this._startupPromise = null;
    this.state.close();
  }

  async enqueueManualNote(input: {
    noteId: string;
    payload: string | Record<string, unknown>;
    updatedAt?: number | null;
  }): Promise<string> {
    if (!this.policy.generateMemories) throw new Error("memory generation is disabled for this runtime policy");
    const noteKey = this.storage.writeManualNoteFile({ noteId: input.noteId, payload: input.payload });
    this.state.enqueueSource({
      sourceType: SOURCE_MANUAL_NOTE,
      sourceRef: noteKey,
      updatedAt: input.updatedAt,
    });
    return noteKey;
  }

  enqueueTradeEvent(input: { tradeId: number; updatedAt?: number | null }): void {
    if (!this.policy.generateMemories) return;
    this.state.enqueueSource({
      sourceType: SOURCE_TRADE_EVENT,
      sourceRef: String(input.tradeId),
      updatedAt: input.updatedAt,
    });
  }

  async runOnce(): Promise<void> {
    if (!this.policy.generateMemories) return;
    const startedAt = Date.now();
    const allowed = this.rateLimitGuard.canRun();
    if (!allowed.ok) {
      memoryLog("warn", "startup_skipped", { reason: allowed.reason });
      return;
    }
    memoryLog("info", "startup_started", {
      max_rollouts_per_startup: this.config.maxRolloutsPerStartup,
      max_raw_memories_for_consolidation: this.config.maxRawMemoriesForConsolidation,
    });
    this.storage.seedAdHocExtensionInstructions();
    const pruned = this.state.pruneStage1OutputsForRetention({
      maxUnusedDays: this.config.maxUnusedDays ?? DEFAULT_MAX_UNUSED_DAYS,
      batchSize: DEFAULT_PRUNE_BATCH_SIZE,
    });
    await this.phase1.scanStartupSources();
    const phase1 = await this.runStage1UntilIdle();
    const phase2Ran = await this.runPhase2Once();
    memoryLog("info", "startup_finished", {
      duration_ms: elapsedMs(startedAt),
      pruned_stage1_outputs: pruned,
      phase1_jobs: phase1.jobs,
      phase1_failed: phase1.failed,
      phase1_lost_lease: phase1.lostLease,
      phase2_ran: phase2Ran,
    });
  }

  async runStage1UntilIdle(batchSize = STAGE1_CONCURRENCY): Promise<{ jobs: number; failed: number; lostLease: number }> {
    const totals = { jobs: 0, failed: 0, lostLease: 0 };
    if (!this.policy.generateMemories) return totals;
    while (true) {
      const allowed = this.rateLimitGuard.canRun();
      if (!allowed.ok) {
        memoryLog("warn", "phase1_skipped", { reason: allowed.reason });
        return totals;
      }
      const jobs = this.state.claimStage1Jobs({ limit: batchSize });
      if (jobs.length === 0) return totals;
      const results = await Promise.all(jobs.map((job) => this.phase1.processJob(job)));
      totals.jobs += results.length;
      totals.failed += results.filter((result) => result.status === "failed").length;
      totals.lostLease += results.filter((result) => result.status === "lost_lease").length;
    }
  }

  async runPhase2Once(limit = this.config.maxRawMemoriesForConsolidation): Promise<boolean> {
    if (!this.policy.generateMemories) return false;
    const allowed = this.rateLimitGuard.canRun();
    if (!allowed.ok) {
      memoryLog("warn", "phase2_skipped", { reason: allowed.reason });
      return false;
    }
    return this.phase2.runOnce({ limit });
  }

  private async _runStartup(): Promise<void> {
    try {
      await this.runOnce();
    } catch (exc) {
      memoryLog("error", "startup_failed", {
        error: exc instanceof Error ? exc.message : String(exc),
      });
    }
  }
}
