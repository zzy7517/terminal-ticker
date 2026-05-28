import { AppConfig } from "../config/index.js";
import { LocalMemoryBackend } from "../memory/backend.js";
import { MemoryPipeline } from "../memory/pipeline.js";
import { MemoryRuntimePolicy } from "../memory/policy.js";
import { NewsService } from "../news/service.js";
import { SocialFeedService } from "../social_feed/service.js";
import { XAuthStore } from "../social_feed/auth.js";
import { XInternalClient } from "../social_feed/providers/x_internal.js";
import { SessionIndex } from "../agent/session_index.js";
import { SessionManager } from "../agent/session_manager.js";
import { ExchangeRouter } from "../trading/exchange_router.js";
import { TradeStore } from "../trading/store.js";
import { TradeStatus } from "../trading/models.js";
import { TickerController } from "../runtime/controller.js";
import { resolveInstruments, MarketInstrument } from "../market_data/router.js";
import { serializeState } from "./serializers.js";
import { CronScheduler } from "../cron/scheduler.js";
import { CronJobStore } from "../cron/job_store.js";
import type { Agent } from "../agent/core/index.js";
import { AgentModelRegistry } from "../agent/model_registry.js";
import { McpClientManager, loadMcpConfig } from "../mcp/index.js";
import { Jin10Service } from "../jin10/index.js";
import { BrowserManager } from "../browser/index.js";
import { DataFeedRegistry } from "../data_feeds/registry.js";
import { FearGreedFeed } from "../data_feeds/fear_greed.js";
import { FundingHistoryFeed } from "../data_feeds/funding_history.js";
import { LongShortRatioFeed } from "../data_feeds/long_short_ratio.js";
import { OIDeltaFeed } from "../data_feeds/oi_delta.js";
import { DXYFeed } from "../data_feeds/dxy.js";
import type { FundingSnapshot, LongShortRatioData, OIDeltaData, DXYData } from "../data_feeds/types.js";
import { PipelineStore } from "../pipeline/store.js";
import { PipelineOrchestrator } from "../pipeline/orchestrator.js";
import { PipelineScheduler } from "../pipeline/scheduler.js";
import { RegimeDetector } from "../pipeline/regime_detector.js";
import { PromptComposer } from "../pipeline/prompt_composer.js";
import type { PipelineRun, PipelineTrigger } from "../pipeline/types.js";
import { EvolutionStore } from "../evolution/store.js";
import { RecommendationTracker } from "../evolution/recommendation_tracker.js";
import { DarwinWeightUpdater } from "../evolution/darwin_weights.js";
import type { Candle } from "../domain/price_action.js";

export class AppRuntime {
  config: AppConfig;
  instruments: MarketInstrument[];
  controller: TickerController;
  readonly tradeStore: TradeStore;
  readonly exchangeRouter: ExchangeRouter;
  newsService: NewsService;
  socialFeedService: SocialFeedService;
  readonly xAuthStore: XAuthStore;
  readonly memoryBackend: LocalMemoryBackend;
  readonly memoryPipeline: MemoryPipeline | null;
  readonly sessionIndex: SessionIndex;
  readonly cronJobStore: CronJobStore;
  readonly cronScheduler: CronScheduler;
  readonly mcpManager: McpClientManager | null;
  jin10Service: Jin10Service;
  readonly browserManager: BrowserManager;
  dataFeeds: DataFeedRegistry;
  pipelineOrchestrator: PipelineOrchestrator | null = null;
  private activePipelineRun: Promise<PipelineRun> | null = null;
  readonly pipelineStore: PipelineStore;
  readonly evolutionStore: EvolutionStore;
  readonly recommendationTracker: RecommendationTracker;
  readonly darwinWeightUpdater: DarwinWeightUpdater;
  readonly pipelineScheduler: PipelineScheduler;
  readonly pendingSessionManagers = new Map<string, SessionManager>();
  /** Active agent instances keyed by session ID. Allows steering/follow-up injection. */
  readonly activeAgents = new Map<string, Agent>();
  private running = false;

  // Private to enforce async construction via `create`; wires all subsystems
  // together but does not start any background tasks.
  private constructor(config: AppConfig, instruments: MarketInstrument[]) {
    this.config = config;
    this.instruments = instruments;
    this.controller = new TickerController({ config, instruments });
    this.tradeStore = new TradeStore();
    this.exchangeRouter = new ExchangeRouter({ tradeStore: this.tradeStore, tradingConfig: config.trading });
    this.newsService = new NewsService({ config: config.news });
    this.xAuthStore = new XAuthStore();
    this.socialFeedService = new SocialFeedService({
      config: config.socialFeed,
      clientFactory: () => new XInternalClient(this.xAuthStore.load()),
    });
    this.memoryBackend = new LocalMemoryBackend(config.memory.storagePath);
    this.sessionIndex = new SessionIndex();
    this.memoryPipeline = this._buildMemoryPipeline(config);

    // Wire MCP client manager
    if (config.mcp.enabled) {
      const mcpConfig = loadMcpConfig(config.mcp.configPath);
      // Ensure jin10 server exists if jin10 is enabled; inject token from toml config
      if (config.jin10.enabled && config.jin10.token) {
        if (!mcpConfig.mcpServers.jin10) {
          mcpConfig.mcpServers.jin10 = {
            url: "https://mcp.jin10.com/mcp",
            headers: {
              "Content-Type": "application/json",
              "Authorization": `Bearer ${config.jin10.token}`,
            },
          };
        } else {
          // Update token in existing jin10 server headers
          const jin10Server = mcpConfig.mcpServers.jin10;
          jin10Server.headers = {
            ...(jin10Server.headers ?? {}),
            "Content-Type": "application/json",
            "Authorization": `Bearer ${config.jin10.token}`,
          };
        }
      }
      const hasServers = Object.keys(mcpConfig.mcpServers).length > 0;
      this.mcpManager = hasServers ? new McpClientManager(mcpConfig) : null;
    } else {
      this.mcpManager = null;
    }

    // Wire Jin10 service (uses MCP bridge)
    this.jin10Service = new Jin10Service({
      config: config.jin10,
      mcpManager: this.mcpManager,
      newsStore: this.newsService.store,
    });

    // Wire browser automation manager
    this.browserManager = new BrowserManager(config.browser);

    // Wire data feeds
    this.dataFeeds = this._buildDataFeeds(config);

    // Wire pipeline + evolution stores
    this.pipelineStore = new PipelineStore();
    this.evolutionStore = new EvolutionStore();
    this.recommendationTracker = new RecommendationTracker(this.evolutionStore);
    this.darwinWeightUpdater = new DarwinWeightUpdater(this.evolutionStore);
    this.pipelineOrchestrator = this._buildPipelineOrchestrator(config);
    this.pipelineScheduler = new PipelineScheduler(this);

    // Wire trade closure → memory pipeline enqueue
    this.tradeStore.onTradeClosed((tradeId) => this.enqueueTradeForMemory(tradeId));
    this.cronJobStore = new CronJobStore();
    this.cronScheduler = new CronScheduler(this, this.cronJobStore);
    SessionManager.reconcileIndex(this.sessionIndex);
  }

  // Resolves the instrument list asynchronously before constructing the runtime,
  // since instrument resolution may involve network calls to provider catalogs.
  static async create(config: AppConfig): Promise<AppRuntime> {
    return new AppRuntime(config, await resolveInstruments(config.instruments));
  }

  // Hot-reloads config after a watchlist TOML change. Stops the controller and
  // news service, rebuilds all stateful subsystems with the new config, then
  // restarts them only if the runtime was already running.
  async reloadConfig(config: AppConfig): Promise<void> {
    const shouldRestart = this.running;
    await this.controller.stop();
    await this.newsService.stop();
    await this.jin10Service.stop();
    this.dataFeeds.stopAll();
    this.pipelineScheduler.stop();
    if (this.activePipelineRun) {
      await this.activePipelineRun.catch(() => undefined);
    }
    this.config = config;
    this.instruments = await resolveInstruments(config.instruments);
    this.controller = new TickerController({ config, instruments: this.instruments });
    this.exchangeRouter.tradingConfig = config.trading;
    this.newsService = new NewsService({ config: config.news });
    this.socialFeedService = new SocialFeedService({
      config: config.socialFeed,
      clientFactory: () => new XInternalClient(this.xAuthStore.load()),
    });
    this.jin10Service = new Jin10Service({
      config: config.jin10,
      mcpManager: this.mcpManager,
      newsStore: this.newsService.store,
    });
    this.dataFeeds = this._buildDataFeeds(config);
    this.pipelineOrchestrator = this._buildPipelineOrchestrator(config);
    if (shouldRestart) {
      this.controller.start();
      await this.newsService.start();
      await this.jin10Service.start();
      if (this.config.dataFeeds.enabled) {
        await this.dataFeeds.startAll();
      }
      this.pipelineScheduler.start();
    }
    this.cronScheduler.reload();
  }

  /**
   * Remove a single instrument from the live runtime without restarting feeds.
   * The TOML file should already be updated before calling this.
   * The controller deregisters the key from its active set — subsequent
   * WebSocket events are explicitly rejected at the gate, and candle polling
   * skips the excluded key on its next iteration.
   */
  removeInstrument(key: string): void {
    this.instruments = this.instruments.filter((i) => i.key !== key);
    this.controller.deregister(key);
  }

  // Starts background market data streaming, news polling, cron scheduler, MCP, and memory pipeline.
  async start(): Promise<void> {
    this.running = true;
    this.controller.start();
    await this.newsService.start();
    this.cronScheduler.start();
    this.mcpManager?.start();
    await this.jin10Service.start();
    this.memoryPipeline?.kickoffStartup();
    if (this.config.dataFeeds.enabled) {
      await this.dataFeeds.startAll();
    }
    this.pipelineScheduler.start();
  }

  // Gracefully stops all background tasks; called on process shutdown or before reload.
  async stop(): Promise<void> {
    this.running = false;
    await this.controller.stop();
    await this.newsService.stop();
    await this.jin10Service.stop();
    await this.cronScheduler.stop();
    await this.mcpManager?.shutdown();
    await this.memoryPipeline?.shutdown();
    this.pipelineScheduler.stop();
    this.dataFeeds.stopAll();
  }

  // Drains pending controller events, fetches live exchange positions/orders,
  // and serializes the full market snapshot consumed by the WebSocket broadcast
  // and the REST /api/state endpoint.
  async state(): Promise<Record<string, unknown>> {
    this.controller.drainEvents();
    const [positions, orders] = await Promise.all([this.exchangeRouter.getAllPositions(), this.exchangeRouter.getAllOrders()]);
    const result = serializeState({
      config: this.config,
      instruments: this.instruments,
      quotes: this.controller.quotes,
      streamStatus: this.controller.streamStatus,
      openTrades: this.tradeStore.listTrades({ statuses: [TradeStatus.OPEN] }),
      exchangePositions: positions,
      exchangeOrders: orders,
      recentNews: this.newsService.recent(),
      newsStatus: {
        enabled: this.config.news.enabled,
        lastStatus: this.newsService.lastStatus,
        lastError: this.newsService.lastError,
        lastFetchedAtMs: this.newsService.lastFetchedAtMs,
      },
      jin10: {
        status: this.jin10Service.getStatus(),
        calendar: this.jin10Service.getCalendar(),
        quotes: this.jin10Service.getQuotes(),
      },
    });

    // Inject pipeline/feeds/evolution data for frontend consumption
    const state = result as Record<string, unknown>;
    state.regime = this.pipelineOrchestrator?.currentRegime ?? null;
    state.feeds = this.dataFeeds.snapshot();
    state.darwinWeights = this.evolutionStore.getDarwinWeights();
    if (this.pipelineOrchestrator?.lastRun) {
      const lr = this.pipelineOrchestrator.lastRun;
      state.lastPipelineRun = {
        id: lr.id,
        status: lr.status,
        decision: lr.decision?.action ?? "PASS",
        modulesAgreeing: lr.decision?.modulesAgreeing ?? 0,
        durationMs: lr.durationMs,
        completedAt: lr.completedAt,
      };
    }
    return state;
  }

  // Enqueue a closed trade into the memory pipeline for automatic extraction.
  enqueueTradeForMemory(tradeId: number): void {
    if (!this.memoryPipeline) return;
    this.memoryPipeline.enqueueTradeEvent({ tradeId });
  }

  /** Run the structured pipeline for one instrument. Used by API and scheduler. */
  async runPipeline(instrumentKey: string, trigger: PipelineTrigger): Promise<PipelineRun> {
    if (!this.config.pipeline.enabled) throw new Error("pipeline disabled");
    if (!this.pipelineOrchestrator) throw new Error("pipeline not configured");
    if (this.activePipelineRun || this.pipelineOrchestrator.isRunning) throw new Error("pipeline already running");
    if (!this.instruments.some((instrument) => instrument.key === instrumentKey)) {
      throw new Error(`unknown instrumentKey: ${instrumentKey}`);
    }
    this.enforcePipelineBudget();
    const runPromise = this.pipelineOrchestrator.run(instrumentKey, trigger);
    this.activePipelineRun = runPromise;
    try {
      return await runPromise;
    } finally {
      if (this.activePipelineRun === runPromise) this.activePipelineRun = null;
    }
  }

  private enforcePipelineBudget(): void {
    const budget = this.config.pipeline.costBudgetDailyUsd;
    if (budget <= 0) return;
    const now = new Date();
    const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();
    const spent = this.pipelineStore.sumCostSince(dayStart);
    if (spent >= budget) {
      throw new Error(`pipeline daily budget exceeded: spent $${spent.toFixed(4)} / $${budget.toFixed(2)}`);
    }
  }

  /** Update Darwin weights using the configured recommendation threshold. */
  updateDarwinWeights(): ReturnType<DarwinWeightUpdater["update"]> {
    if (!this.config.evolution.enabled) return [];
    return this.darwinWeightUpdater.update(this.config.evolution.minRecommendationsForEval);
  }

  /** Back-fill forward returns for stored module recommendations. */
  async backfillRecommendationReturns(): Promise<number> {
    if (!this.config.evolution.enabled) return 0;
    return this.recommendationTracker.backfillReturns((instrumentKey) => this.getCurrentPrice(instrumentKey));
  }

  // Builds the memory pipeline from current config; returns null when disabled.
  private _buildMemoryPipeline(config: AppConfig): MemoryPipeline | null {
    if (!config.memory.enabled) return null;

    const registry = new AgentModelRegistry();
    const tradeStore = this.tradeStore;
    const sessionIndex = this.sessionIndex;

    const sessionSource = {
      listSessions(input: { limit?: number }) {
        return sessionIndex.listSessions({ limit: input.limit }).map((row) => ({
          id: row.id,
          updatedAt: row.updatedAt,
          messageCount: row.messageCount,
        }));
      },
      sessionPayload(sessionId: string) {
        const row = sessionIndex.get(sessionId);
        if (!row) return null;
        try {
          const mgr = SessionManager.open(row.filePath);
          return mgr.sessionPayload();
        } catch {
          return null;
        }
      },
    };

    const agentConfigProvider = () => config.agent;
    const llmProviderFactory = (agentConfig: typeof config.agent) => registry.createProvider(agentConfig);

    return new MemoryPipeline({
      config: config.memory,
      sessionSource,
      tradeStore,
      agentConfigProvider,
      llmProviderFactory,
      policy: config.memory.generateMemories
        ? MemoryRuntimePolicy.normal()
        : MemoryRuntimePolicy.disabled(),
    });
  }

  // Builds the structured pipeline orchestrator when enabled.
  private _buildPipelineOrchestrator(config: AppConfig): PipelineOrchestrator | null {
    if (!config.pipeline.enabled) return null;

    const regimeDetector = new RegimeDetector({
      dataFeeds: this.dataFeeds,
      getVIX: () => this.getVIX(),
      getADX: (instrumentKey) => this.getADX(instrumentKey),
      getPrimaryFunding: (instrumentKey) => this.getFundingRate(instrumentKey),
    });

    return new PipelineOrchestrator({
      regimeDetector,
      promptComposer: new PromptComposer(),
      llmCall: (systemPrompt, userPrompt) => this.callPipelineLLM(systemPrompt, userPrompt),
      getCandleData: (instrumentKey) => this.formatCandleData(instrumentKey),
      getCurrentPrice: (instrumentKey) => this.getCurrentPrice(instrumentKey),
      getDarwinWeights: () => this.evolutionStore.getDarwinWeights(),
      getFundamentalContext: (instrumentKey) => this.getFundamentalContext(instrumentKey),
      getFundingRate: (instrumentKey) => this.getFundingRate(instrumentKey),
      getLongShortRatio: (instrumentKey) => this.getLongShortRatio(instrumentKey),
      getOIDelta: (instrumentKey) => this.getOIDelta(instrumentKey),
      onComplete: (run) => {
        this.pipelineStore.insert(run);
        if (!this.config.evolution.enabled || run.status !== "completed") return;
        const currentPrice = this.getCurrentPrice(run.instrumentKey);
        if (currentPrice === null) return;
        this.recommendationTracker.recordFromPipelineRun(run.moduleResults, run.instrumentKey, currentPrice);
      },
    });
  }

  private async callPipelineLLM(systemPrompt: string, userPrompt: string): Promise<{ content: string; tokensUsed: number }> {
    if (!this.config.agent.enabled) throw new Error("agent provider disabled");
    const provider = new AgentModelRegistry().createProvider(this.config.agent);
    const response = await provider.chat({
      system: systemPrompt,
      messages: [{ role: "user", content: userPrompt, timestamp: Date.now() }],
      onDelta: null,
    });
    return {
      content: response.content,
      tokensUsed: response.message.usage?.totalTokens ?? 0,
    };
  }

  private getCurrentPrice(instrumentKey: string): number | null {
    return this.controller.quotes[instrumentKey]?.price ?? null;
  }

  private getVIX(): number | null {
    const direct = this.controller.quotes["hyperliquid:xyz:VIX"]?.price;
    if (direct !== undefined && direct !== null) return direct;
    for (const [key, quote] of Object.entries(this.controller.quotes)) {
      if (key.toUpperCase().includes("VIX") || quote.symbol.toUpperCase().includes("VIX") || quote.displayName.toUpperCase().includes("VIX")) {
        if (quote.price !== null) return quote.price;
      }
    }
    return null;
  }

  private getADX(instrumentKey: string, period = 14): number | null {
    const candles = this.controller.quotes[instrumentKey]?.candles ?? [];
    if (candles.length < period * 2) return null;

    const dxValues: number[] = [];
    for (let end = period + 1; end <= candles.length; end += 1) {
      const window = candles.slice(end - period - 1, end);
      const sums = this.sumDirectionalMovement(window);
      if (sums.tr === 0) continue;
      const plusDI = (100 * sums.plusDM) / sums.tr;
      const minusDI = (100 * sums.minusDM) / sums.tr;
      const denom = plusDI + minusDI;
      if (denom === 0) continue;
      dxValues.push((100 * Math.abs(plusDI - minusDI)) / denom);
    }

    const recent = dxValues.slice(-period);
    if (recent.length === 0) return null;
    const adx = recent.reduce((sum, value) => sum + value, 0) / recent.length;
    return Math.round(adx * 10) / 10;
  }

  private sumDirectionalMovement(candles: Candle[]): { tr: number; plusDM: number; minusDM: number } {
    let tr = 0;
    let plusDM = 0;
    let minusDM = 0;
    for (let index = 1; index < candles.length; index += 1) {
      const current = candles[index];
      const previous = candles[index - 1];
      const trueRange = Math.max(
        current.high - current.low,
        Math.abs(current.high - previous.close),
        Math.abs(current.low - previous.close),
      );
      const upMove = current.high - previous.high;
      const downMove = previous.low - current.low;
      tr += trueRange;
      if (upMove > downMove && upMove > 0) plusDM += upMove;
      if (downMove > upMove && downMove > 0) minusDM += downMove;
    }
    return { tr, plusDM, minusDM };
  }

  private formatCandleData(instrumentKey: string): string {
    const quote = this.controller.quotes[instrumentKey];
    const candles = quote?.candles ?? [];
    if (candles.length === 0) return "No candle data available yet.";
    const limit = Math.max(10, Math.min(this.config.agent.maxCandles, 120));
    return candles.slice(-limit).map((candle) => [
      new Date(candle.openTimeMs).toISOString(),
      `O:${candle.open}`,
      `H:${candle.high}`,
      `L:${candle.low}`,
      `C:${candle.close}`,
      `V:${candle.volume}`,
    ].join(" ")).join("\n");
  }

  private getFundamentalContext(instrumentKey: string): string {
    const parts: string[] = [];
    const quote = this.controller.quotes[instrumentKey];
    if (quote) {
      parts.push(`Price: ${quote.price ?? "unknown"}`);
      parts.push(`24h Change: ${quote.changePercent ?? "unknown"}%`);
      parts.push(`Volume: ${quote.volume ?? "unknown"}`);
    }
    const funding = this.getFundingSnapshot(instrumentKey);
    if (funding) parts.push(`Funding Rate: ${(funding.rate * 100).toFixed(4)}%`);
    const ls = this.getLongShortSnapshot(instrumentKey);
    if (ls) parts.push(`Long/Short Ratio: ${ls.ratio.toFixed(2)} (long ${ls.longPct.toFixed(1)}%, short ${ls.shortPct.toFixed(1)}%)`);
    const oi = this.getOIDeltaSnapshot(instrumentKey);
    if (oi) parts.push(`OI: ${oi.oi}, OI Delta 1h: ${oi.delta1h}, 4h: ${oi.delta4h}, 24h: ${oi.delta24h}`);
    const dxy = this.dataFeeds.get<DXYData>("dxy")?.getLatest();
    if (dxy) parts.push(`DXY proxy: ${dxy.value} (EURUSD ${dxy.eurusd})`);
    return parts.length > 0 ? parts.join("\n") : "No additional context available.";
  }

  private getFundingRate(instrumentKey: string): number | null {
    return this.getFundingSnapshot(instrumentKey)?.rate ?? null;
  }

  private getLongShortRatio(instrumentKey: string): number | null {
    return this.getLongShortSnapshot(instrumentKey)?.ratio ?? null;
  }

  private getOIDelta(instrumentKey: string): number | null {
    return this.getOIDeltaSnapshot(instrumentKey)?.delta1h ?? null;
  }

  private getFundingSnapshot(instrumentKey: string): FundingSnapshot | null {
    return this.latestFeedItemForInstrument<FundingSnapshot>("funding", instrumentKey);
  }

  private getLongShortSnapshot(instrumentKey: string): LongShortRatioData | null {
    return this.latestFeedItemForInstrument<LongShortRatioData>("long_short_ratio", instrumentKey);
  }

  private getOIDeltaSnapshot(instrumentKey: string): OIDeltaData | null {
    return this.latestFeedItemForInstrument<OIDeltaData>("oi_delta", instrumentKey);
  }

  private latestFeedItemForInstrument<T extends { instrumentKey: string; timestamp?: string }>(name: string, instrumentKey: string): T | null {
    const feed = this.dataFeeds.get<T>(name);
    if (!feed) return null;
    const history = feed.getHistory(200).filter((item) => item.instrumentKey === instrumentKey);
    if (history.length === 0) return null;
    return history[history.length - 1];
  }

  // Builds the DataFeedRegistry with configured feeds.
  private _buildDataFeeds(config: AppConfig): DataFeedRegistry {
    const registry = new DataFeedRegistry();
    const feedCfg = config.dataFeeds;

    // Fear & Greed
    registry.register(new FearGreedFeed(feedCfg.fearGreedIntervalSeconds * 1000));

    // Funding rate / positioning for resolved Bitget futures symbols.
    const bitgetTargets = this.instruments.flatMap((instrument) => {
      if (instrument.source !== "bitget" || !("instType" in instrument) || !instrument.instType.includes("FUTURES")) return [];
      return [{
        instrumentKey: instrument.key,
        symbol: instrument.symbol,
        productType: instrument.instType,
      }];
    });
    if (bitgetTargets.length > 0) {
      registry.register(new FundingHistoryFeed({
        targets: bitgetTargets,
        pollIntervalMs: feedCfg.fundingIntervalSeconds * 1000,
      }));
      registry.register(new LongShortRatioFeed({
        targets: bitgetTargets,
        pollIntervalMs: feedCfg.longShortIntervalSeconds * 1000,
      }));
      registry.register(new OIDeltaFeed({
        targets: bitgetTargets,
        pollIntervalMs: feedCfg.oiDeltaIntervalSeconds * 1000,
      }));
    }

    // DXY (derived from Jin10 EURUSD quote)
    registry.register(new DXYFeed({
      getEURUSD: () => {
        const quotes = this.jin10Service.getQuotes();
        const eurusd = quotes.find((q) => q.code === "EURUSD");
        return eurusd?.close ?? null;
      },
      pollIntervalMs: 30_000,
    }));

    return registry;
  }
}
