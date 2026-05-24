import type { AgentConfig, MemoryConfig } from "../config/index.js";
import type { LLMChatClient } from "../agent/llm_client.js";
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
import { Phase1Processor, normalizePhase1Output, type Phase1Extraction, type LLMProviderFactory, type SessionSource } from "./write/phase1.js";
import { Phase2Runner } from "./write/phase2.js";

const STAGE1_CONCURRENCY = 4;
const DEFAULT_PHASE2_HEARTBEAT_MS = 90_000;
const DEFAULT_STARTUP_SCAN_LIMIT = 5_000;
const DEFAULT_MAX_SOURCE_AGE_DAYS = 180;
const DEFAULT_MIN_AGENT_SESSION_IDLE_HOURS = 12;
const DEFAULT_EXTENSION_RETENTION_DAYS = 7;

export class MemoryPipeline {
  readonly root: string;
  readonly config: MemoryConfig;
  readonly policy: MemoryRuntimePolicy;
  readonly state: MemoryStateStore;
  readonly storage: MemoryFileStorage;
  readonly phase1: Phase1Processor;
  readonly phase2: Phase2Runner;
  private _startupPromise: Promise<void> | null = null;

  constructor(input: {
    config: MemoryConfig;
    state?: MemoryStateStore;
    sessionSource?: SessionSource;
    tradeStore?: TradeStore;
    agentConfigProvider?: (() => AgentConfig | null) | null;
    phase2ConfigProvider?: (() => AgentConfig | null) | null;
    llmProviderFactory?: LLMProviderFactory;
    policy?: MemoryRuntimePolicy;
  }) {
    this.config = input.config;
    this.root = ensureMemoryLayout(input.config.storagePath);
    this.policy = input.policy ?? MemoryRuntimePolicy.normal();
    this.state = input.state ?? new MemoryStateStore();

    const tradeStore = input.tradeStore;
    const sessionSource: SessionSource = input.sessionSource ?? { listSessions: () => [], sessionPayload: () => null };
    const agentConfigProvider = input.agentConfigProvider ?? null;
    const llmProviderFactory = input.llmProviderFactory ?? (() => { throw new Error("no LLM provider factory configured"); }) as unknown as LLMProviderFactory;

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
      agentConfigProvider,
      llmProviderFactory,
      startupScanLimit: input.config.maxRolloutsPerStartup ?? DEFAULT_STARTUP_SCAN_LIMIT,
      maxSourceAgeDays: input.config.maxSourceAgeDays ?? DEFAULT_MAX_SOURCE_AGE_DAYS,
      minAgentSessionIdleHours: input.config.minSessionIdleHours ?? DEFAULT_MIN_AGENT_SESSION_IDLE_HOURS,
    });

    this.phase2 = new Phase2Runner({
      root: this.root,
      stateStore: this.state,
      storage: this.storage,
      agentConfigProvider: input.phase2ConfigProvider ?? agentConfigProvider,
      llmProviderFactory,
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
    this.state.pruneStage1OutputsForRetention({
      maxUnusedDays: this.config.maxUnusedDays ?? DEFAULT_MAX_UNUSED_DAYS,
      batchSize: DEFAULT_PRUNE_BATCH_SIZE,
    });
    await this.phase1.scanStartupSources();
    await this.runStage1UntilIdle();
    await this.runPhase2Once();
  }

  async runStage1UntilIdle(batchSize = STAGE1_CONCURRENCY): Promise<void> {
    if (!this.policy.generateMemories) return;
    while (true) {
      const jobs = this.state.claimStage1Jobs({ limit: batchSize });
      if (jobs.length === 0) return;
      await Promise.all(jobs.map((job) => this.phase1.processJob(job)));
    }
  }

  async runPhase2Once(limit = 100): Promise<boolean> {
    if (!this.policy.generateMemories) return false;
    return this.phase2.runOnce({ limit });
  }

  private async _runStartup(): Promise<void> {
    try {
      await this.runOnce();
    } catch (exc) {
      console.error("memory startup pipeline failed", exc);
    }
  }
}
