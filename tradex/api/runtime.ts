import { AppConfig } from "../config/index.js";
import { LocalMemoryBackend } from "../memory/backend.js";
import { NewsService } from "../news/service.js";
import { SocialFeedService } from "../social_feed/service.js";
import { XAuthStore } from "../social_feed/auth.js";
import { XInternalClient } from "../social_feed/providers/x_internal.js";
import { SessionIndex } from "../agent/session_index.js";
import { SessionManager } from "../agent/session_manager.js";
import { ExchangeRouter } from "../trading/exchange_router.js";
import { TradeStore } from "../trading/store.js";
import { TickerController } from "../runtime/controller.js";
import { resolveInstruments, MarketInstrument } from "../market_data/router.js";
import { TradeStatus } from "../trading/models.js";
import { serializeState } from "./serializers.js";
import { CronScheduler } from "../cron/scheduler.js";

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
  readonly sessionIndex: SessionIndex;
  readonly cronScheduler: CronScheduler;
  readonly pendingSessionManagers = new Map<string, SessionManager>();
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
    this.cronScheduler = new CronScheduler(this);
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
    this.config = config;
    this.instruments = await resolveInstruments(config.instruments);
    this.controller = new TickerController({ config, instruments: this.instruments });
    this.exchangeRouter.tradingConfig = config.trading;
    this.newsService = new NewsService({ config: config.news });
    this.socialFeedService = new SocialFeedService({
      config: config.socialFeed,
      clientFactory: () => new XInternalClient(this.xAuthStore.load()),
    });
    if (shouldRestart) {
      this.controller.start();
      await this.newsService.start();
    }
    // Reload cron timers regardless of running state so they pick up config changes
    this.cronScheduler.reload(config.cronJobs);
  }

  // Starts background market data streaming, news polling, and cron scheduler.
  async start(): Promise<void> {
    this.running = true;
    this.controller.start();
    await this.newsService.start();
    this.cronScheduler.start();
  }

  // Gracefully stops all background tasks; called on process shutdown or before reload.
  async stop(): Promise<void> {
    this.running = false;
    await this.controller.stop();
    await this.newsService.stop();
    await this.cronScheduler.stop();
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
    });
  }
}
