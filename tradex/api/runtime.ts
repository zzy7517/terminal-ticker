import { AppConfig } from "../config/index.js";
import { LocalMemoryBackend } from "../memory/backend.js";
import { MemoryPipeline } from "../memory/pipeline.js";
import { MemoryRuntimePolicy } from "../memory/policy.js";
import { LocalMemoryPort, type MemoryPort } from "../memory/port.js";
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
import type { ActiveAgentRun } from "../agent/pi_runtime.js";
import { AgentModelRegistry } from "../agent/model_registry.js";
import { McpClientManager, loadMcpConfig } from "../mcp/index.js";
import { Jin10Service } from "../jin10/index.js";
import { BrowserManager } from "../browser/index.js";
import { OptionsService } from "../options/service.js";
import { applyProxyConfig } from "../runtime/proxy.js";

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
  memoryPipeline: MemoryPipeline | null;
  memoryPort: MemoryPort;
  readonly sessionIndex: SessionIndex;
  readonly cronJobStore: CronJobStore;
  readonly cronScheduler: CronScheduler;
  readonly mcpManager: McpClientManager | null;
  jin10Service: Jin10Service;
  readonly browserManager: BrowserManager;
  optionsService: OptionsService | null;
  readonly pendingSessionManagers = new Map<string, SessionManager>();
  /** Active agent instances keyed by session ID. Allows steering/follow-up injection. */
  readonly activeAgents = new Map<string, ActiveAgentRun>();
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
    this.memoryPort = new LocalMemoryPort(config.memory, () => this.memoryPipeline);

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

    // Wire options/GEX service
    this.optionsService = config.options.enabled
      ? new OptionsService(config.options)
      : null;

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
    this.config = config;
    // Re-apply the outbound proxy before rebuilding subsystems so new feeds
    // pick up the updated dispatcher on their first request.
    applyProxyConfig(config.proxy);
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
    // Rebuild options/memory subsystems so toggling them via the config API
    // takes effect without a process restart.
    await this.optionsService?.close();
    this.optionsService = config.options.enabled ? new OptionsService(config.options) : null;
    await this.memoryPipeline?.shutdown();
    this.memoryPipeline = this._buildMemoryPipeline(config);
    this.memoryPort = new LocalMemoryPort(config.memory, () => this.memoryPipeline);
    if (shouldRestart) {
      this.controller.start();
      await this.newsService.start();
      await this.jin10Service.start();
      this.optionsService?.start();
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
    this.optionsService?.start();
    this.memoryPipeline?.kickoffStartup();
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
    await this.optionsService?.close();
  }

  // Drains pending controller events, fetches live exchange positions/orders,
  // and serializes the full market snapshot consumed by the WebSocket broadcast
  // and the REST /api/state endpoint.
  async state(): Promise<Record<string, unknown>> {
    this.controller.drainEvents();
    const [positions, orders] = await Promise.all([this.exchangeRouter.getAllPositions(), this.exchangeRouter.getAllOrders()]);
    return serializeState({
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
      options: this.optionsService ? {
        snapshots: Object.fromEntries(
          Array.from(this.optionsService.getAllSnapshots().entries()).map(([symbol, snap]) => [
            symbol,
            {
              symbol: snap.symbol,
              spotPrice: snap.spotPrice,
              netGexBillions: Math.round(snap.netGexBillions * 100) / 100,
              regime: snap.regime,
              regimeDescription: snap.regimeDescription,
              zeroGammaLevel: snap.zeroGammaLevel,
              callWall: snap.keyLevels.callWall,
              putWall: snap.keyLevels.putWall,
              maxGammaStrike: snap.keyLevels.maxGammaStrike,
              dominantStrike: snap.dominantStrike,
              charmFlow: snap.charmVanna?.charmFlow ?? null,
              vannaFlow: snap.charmVanna?.vannaFlow ?? null,
              gexByStrike: snap.gexByStrike,
              provider: snap.provider,
              timestamp: snap.timestamp,
              // ── Advanced analytics (A modules) ──
              regimeParams: snap.regimeParams
                ? {
                    atmIV: snap.regimeParams.atmIV,
                    regime: snap.regimeParams.regime,
                    impliedSpotVolCorr: snap.regimeParams.impliedSpotVolCorr,
                    impliedVolOfVol: snap.regimeParams.impliedVolOfVol,
                    expectedDailySpotMove: snap.regimeParams.expectedDailySpotMove,
                  }
                : null,
              ivSurface: snap.ivSurface
                ? {
                    expiration: snap.ivSurface.expiration,
                    strikes: snap.ivSurface.strikes,
                    smoothedIVs: snap.ivSurface.smoothedIVs,
                  }
                : null,
              hedgeImpulse: snap.hedgeImpulse
                ? {
                    regime: snap.hedgeImpulse.regime,
                    impulseAtSpot: snap.hedgeImpulse.impulseAtSpot,
                    nearestAttractorAbove: snap.hedgeImpulse.nearestAttractorAbove,
                    nearestAttractorBelow: snap.hedgeImpulse.nearestAttractorBelow,
                    asymmetry: snap.hedgeImpulse.asymmetry,
                    curve: snap.hedgeImpulse.curve.map((p) => ({
                      price: p.price,
                      impulse: p.impulse,
                    })),
                  }
                : null,
              pressureCloud: snap.pressureCloud
                ? {
                    stabilityZones: snap.pressureCloud.stabilityZones,
                    accelerationZones: snap.pressureCloud.accelerationZones,
                    regimeEdges: snap.pressureCloud.regimeEdges,
                  }
                : null,
              exposure: snap.exposure
                ? snap.exposure.map((e) => ({
                    expiration: e.expiration,
                    tte: e.tte,
                    totalGammaExposure: e.canonical.totalGammaExposure,
                    totalDeltaExposure: e.canonical.totalDeltaExposure,
                    totalVannaExposure: e.canonical.totalVannaExposure,
                    totalCharmExposure: e.canonical.totalCharmExposure,
                  }))
                : null,
            },
          ]),
        ),
      } : null,
    });
  }

  // Enqueue a closed trade into the memory pipeline for automatic extraction.
  enqueueTradeForMemory(tradeId: number): void {
    if (!this.memoryPipeline) return;
    this.memoryPipeline.enqueueTradeEvent({ tradeId });
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
}
