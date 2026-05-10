import { AppConfig } from "../config/index.js";
import { LocalMemoryBackend } from "../memory/backend.js";
import { NewsService } from "../news/service.js";
import { SocialFeedService } from "../social_feed/service.js";
import { XAuthStore } from "../social_feed/auth.js";
import { XInternalClient } from "../social_feed/providers/x_internal.js";
import { AgentSessionStore } from "../agent/session_store.js";
import { ExchangeRouter } from "../trading/exchange_router.js";
import { TradeStore } from "../trading/store.js";
import { TickerController } from "../runtime/controller.js";
import { resolveInstruments, MarketInstrument } from "../market_data/router.js";
import { serializeState } from "./serializers.js";

export class MarketRuntime {
  config: AppConfig;
  instruments: MarketInstrument[];
  controller: TickerController;
  readonly tradeStore: TradeStore;
  readonly exchangeRouter: ExchangeRouter;
  readonly newsService: NewsService;
  readonly socialFeedService: SocialFeedService;
  readonly xAuthStore: XAuthStore;
  readonly memoryBackend: LocalMemoryBackend;
  readonly agentSessionStore: AgentSessionStore;

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
    this.agentSessionStore = new AgentSessionStore();
  }

  static async create(config: AppConfig): Promise<MarketRuntime> {
    return new MarketRuntime(config, await resolveInstruments(config.instruments));
  }

  async reloadConfig(config: AppConfig): Promise<void> {
    await this.controller.stop();
    this.config = config;
    this.instruments = await resolveInstruments(config.instruments);
    this.controller = new TickerController({ config, instruments: this.instruments });
    this.exchangeRouter.tradingConfig = config.trading;
    Object.assign(this.newsService.config, config.news);
    Object.assign(this.socialFeedService.config, config.socialFeed);
    this.controller.start();
  }

  async start(): Promise<void> {
    this.controller.start();
    await this.newsService.start();
  }

  async stop(): Promise<void> {
    await this.controller.stop();
    await this.newsService.stop();
  }

  async state(): Promise<Record<string, unknown>> {
    this.controller.drainEvents();
    const [positions, orders] = await Promise.all([this.exchangeRouter.getAllPositions(), this.exchangeRouter.getAllOrders()]);
    return serializeState({
      config: this.config,
      instruments: this.instruments,
      quotes: this.controller.quotes,
      streamStatus: this.controller.streamStatus,
      openTrades: this.tradeStore.listTrades({ statuses: ["open" as never] }),
      exchangePositions: positions,
      exchangeOrders: orders,
      recentNews: this.newsService.recent(),
      newsStatus: { enabled: this.config.news.enabled },
    });
  }
}
