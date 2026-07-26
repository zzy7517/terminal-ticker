/** 持有进程级服务、存储、Session 锁和活动 Runtime 句柄。 */
import { AppConfig } from "../config/index.js";
import { NewsService } from "../news/service.js";
import type { SessionManager } from "@earendil-works/pi-coding-agent";
import { ExchangeRouter } from "../trading/exchange_router.js";
import { TradeStore } from "../trading/store.js";
import { TradeStatus } from "../trading/models.js";
import { TickerController } from "../runtime/controller.js";
import { resolveInstruments, MarketInstrument } from "../market_data/router.js";
import { serializeState } from "./serializers.js";
import { CronScheduler } from "../cron/scheduler.js";
import { CronJobStore } from "../cron/job_store.js";
import type { ActiveRuntimeRun } from "../agent/runtime/types.js";
import {
  buildModelRuntimeSnapshot,
  type ModelRuntimeSnapshot,
} from "../agent/runtime/pi/models/runtime.js";
import { McpClientManager, loadMcpConfig } from "../mcp/index.js";
import { Jin10Service } from "../jin10/index.js";
import { BrowserManager } from "../browser/index.js";
import { OptionsService } from "../options/service.js";
import { MacroService } from "../macro/service.js";
import { applyProxyConfig } from "../runtime/proxy.js";
import { AgentStore } from "../agent/agent_store.js";
import { AgentContextManager } from "../agent/context-manager.js";
import { indexPersistedAgentSessions, importLegacySessionMessages } from "../agent/chat-index.js";
import { ChannelStore } from "../channel/store.js";
import { MessageStore } from "../chat/message-store.js";
import { InboxStore } from "../chat/inbox-store.js";
import { UnreadStore } from "../chat/unread-store.js";
import { ChatEventStore } from "../chat/events.js";
import type { AgentCoordinator } from "../chat/coordinator.js";
import type { SessionAgentSnapshot } from "../agent/runtime/pi/sessions.js";
import { CliRunGrantStore } from "../agent/runtime/cli-tools.js";
import { ClaudeSessionStore } from "../agent/runtime/claude-code/session-store.js";
import { CursorSessionStore } from "../agent/runtime/cursor/session-store.js";
import { AgentSkillCatalog } from "../agent/skills.js";
import { OriginSessionStore } from "../origin/session-store.js";

export class AppRuntime {
  config: AppConfig;
  instruments: MarketInstrument[];
  controller: TickerController;
  readonly tradeStore: TradeStore;
  readonly exchangeRouter: ExchangeRouter;
  newsService: NewsService;
  readonly cronJobStore: CronJobStore;
  readonly cronScheduler: CronScheduler;
  readonly mcpManager: McpClientManager | null;
  jin10Service: Jin10Service;
  readonly browserManager: BrowserManager;
  optionsService: OptionsService | null;
  macroService: MacroService;
  readonly pendingSessionManagers = new Map<string, SessionManager>();
  readonly pendingAgentSnapshots = new Map<string, SessionAgentSnapshot>();
  readonly agentStore: AgentStore;
  readonly agentContextManager: AgentContextManager;
  readonly channelStore: ChannelStore;
  readonly messageStore: MessageStore;
  readonly inboxStore: InboxStore;
  readonly unreadStore: UnreadStore;
  readonly chatEventStore: ChatEventStore;
  agentCoordinator: AgentCoordinator | null = null;
  /** Session-level mutation lock covering setup, streaming, and delete. */
  readonly lockedAgentSessions = new Set<string>();
  /** Active agent instances keyed by session ID for abort control. */
  readonly activeAgents = new Map<string, ActiveRuntimeRun>();
  readonly cliRunGrants = new CliRunGrantStore();
  readonly claudeSessions = new ClaudeSessionStore();
  readonly cursorSessions = new CursorSessionStore();
  readonly skillCatalog = new AgentSkillCatalog();
  readonly originSessions = new OriginSessionStore();
  /** Loopback HTTP origin for this process (CLI gateway, etc.). Set at serve time. */
  listenOrigin = "http://127.0.0.1:8765";
  private _modelRuntimeSnapshot: ModelRuntimeSnapshot;
  private running = false;

  // Private to enforce async construction via `create`; wires all subsystems
  // together but does not start any background tasks.
  private constructor(
    config: AppConfig,
    instruments: MarketInstrument[],
    modelRuntimeSnapshot: ModelRuntimeSnapshot,
  ) {
    this.config = config;
    this.agentStore = new AgentStore();
    this.agentContextManager = new AgentContextManager();
    this.channelStore = new ChannelStore();
    this.messageStore = new MessageStore();
    this.inboxStore = new InboxStore();
    this.unreadStore = new UnreadStore();
    this.chatEventStore = new ChatEventStore();
    this._modelRuntimeSnapshot = modelRuntimeSnapshot;
    this.instruments = instruments;
    this.controller = new TickerController({ config, instruments });
    this.tradeStore = new TradeStore();
    this.exchangeRouter = new ExchangeRouter({ tradingConfig: config.trading });
    this.newsService = new NewsService({ config: config.news });

    // Wire MCP client manager
    if (config.mcp.enabled) {
      const mcpConfig = loadMcpConfig(config.mcp.configPath);
      const hasServers = Object.keys(mcpConfig.mcpServers).length > 0;
      this.mcpManager = hasServers ? new McpClientManager(mcpConfig) : null;
    } else {
      this.mcpManager = null;
    }

    // Wire Jin10 service — owns its own MCP connection, independent of [mcp]
    this.jin10Service = new Jin10Service({
      config: config.jin10,
      newsStore: this.newsService.store,
    });

    // Wire browser automation manager
    this.browserManager = new BrowserManager(config.browser);

    // Wire options/GEX service
    this.optionsService = config.options.enabled
      ? new OptionsService(config.options)
      : null;

    // Wire macro data layer. Takes the Jin10 service as a calendar provider but
    // stays usable without it (FRED series are independent).
    this.macroService = new MacroService({
      config: config.macro,
      jin10Service: this.jin10Service,
    });

    this.cronJobStore = new CronJobStore();
    this.cronScheduler = new CronScheduler(this, this.cronJobStore);
  }

  // Resolves the instrument list asynchronously before constructing the runtime,
  // since instrument resolution may involve network calls to provider catalogs.
  static async create(config: AppConfig): Promise<AppRuntime> {
    const modelRuntimeSnapshot = await buildModelRuntimeSnapshot(config.agent, 1);
    return new AppRuntime(
      config,
      await resolveInstruments(config.instruments),
      modelRuntimeSnapshot,
    );
  }

  get modelRuntimeSnapshot(): ModelRuntimeSnapshot {
    return this._modelRuntimeSnapshot;
  }

  // Hot-reloads config after a watchlist TOML change. Stops the controller and
  // news service, rebuilds all stateful subsystems with the new config, then
  // restarts them only if the runtime was already running.
  async reloadConfig(config: AppConfig): Promise<void> {
    // Build and validate replacement state off to the side. No live caller can
    // observe it until the single snapshot assignment below.
    const nextModelRuntime = await buildModelRuntimeSnapshot(
      config.agent,
      this._modelRuntimeSnapshot.generation + 1,
    );
    const nextInstruments = await resolveInstruments(config.instruments);
    const shouldRestart = this.running;
    await this.controller.stop();
    await this.newsService.stop();
    await this.jin10Service.stop();
    await this.macroService.stop();
    this.config = config;
    this._modelRuntimeSnapshot = nextModelRuntime;
    // Re-apply the outbound proxy before rebuilding subsystems so new feeds
    // pick up the updated dispatcher on their first request.
    applyProxyConfig(config.proxy);
    this.instruments = nextInstruments;
    this.controller = new TickerController({ config, instruments: this.instruments });
    this.exchangeRouter.tradingConfig = config.trading;
    this.newsService = new NewsService({ config: config.news });
    this.jin10Service = new Jin10Service({
      config: config.jin10,
      newsStore: this.newsService.store,
    });
    // Rebuild the optional subsystem so toggling it via the config API takes
    // effect without a process restart.
    await this.optionsService?.close();
    this.agentContextManager.close();
    this.channelStore.close();
    this.messageStore.close();
    this.inboxStore.close();
    this.unreadStore.close();
    this.chatEventStore.close();
    this.optionsService = config.options.enabled ? new OptionsService(config.options) : null;
    this.macroService.close();
    this.macroService = new MacroService({
      config: config.macro,
      jin10Service: this.jin10Service,
    });
    if (shouldRestart) {
      this.controller.start();
      await this.newsService.start();
      await this.jin10Service.start();
      this.optionsService?.start();
      await this.macroService.start();
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

  // Starts background market data streaming, news polling, cron scheduler, and MCP.
  async start(): Promise<void> {
    await indexPersistedAgentSessions(this);
    await importLegacySessionMessages(this);
    this.messageStore.migrateLegacyDirectChatTargets();
    const { AgentCoordinator } = await import("../chat/coordinator.js");
    this.agentCoordinator = new AgentCoordinator(this, this.config.channels.activationDebounceMs);
    this.agentCoordinator.start();
    this.running = true;
    this.controller.start();
    await this.newsService.start();
    this.cronScheduler.start();
    this.mcpManager?.start();
    await this.jin10Service.start();
    this.optionsService?.start();
    // Started after Jin10 so the calendar provider can reuse a warm connection.
    await this.macroService.start();
  }

  // Gracefully stops all background tasks; called on process shutdown or before reload.
  async stop(): Promise<void> {
    this.running = false;
    this.agentCoordinator?.stop();
    this.agentCoordinator = null;
    await this.controller.stop();
    await this.newsService.stop();
    await this.jin10Service.stop();
    await this.cronScheduler.stop();
    await this.mcpManager?.shutdown();
    await this.optionsService?.close();
    await this.macroService.stop();
    this.macroService.close();
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

}
