import { AppConfig } from "../config/index.js";
import { QuoteState } from "../domain/quotes.js";
import { MarketInstrument } from "../market_data/router.js";
import { ExchangeOrder, ExchangePosition, orderToPayload, positionToPayload } from "../trading/exchange_models.js";
import { Trade, tradeToPayload } from "../trading/models.js";
import { NewsItem, newsItemToPayload } from "../news/types.js";

export function serializeState(input: {
  config: AppConfig;
  instruments: readonly MarketInstrument[];
  quotes: Record<string, QuoteState>;
  streamStatus: string;
  openTrades: Trade[];
  exchangePositions: ExchangePosition[];
  exchangeOrders: ExchangeOrder[];
  recentNews: NewsItem[];
  newsStatus?: Record<string, unknown>;
}): Record<string, unknown> {
  const groups: Record<string, string[]> = {};
  for (const instrument of input.instruments) {
    const group = instrument.source || "other";
    groups[group] = [...(groups[group] ?? []), instrument.key];
  }
  return {
    type: "state",
    updatedAt: new Date().toISOString(),
    streamStatus: input.streamStatus,
    config: serializeConfig(input.config),
    instruments: input.instruments.map((instrument) => ({
      key: instrument.key,
      symbol: instrument.symbol,
      label: instrument.label,
      source: instrument.source,
      instType: "instType" in instrument ? instrument.instType : null,
      group: instrument.group,
      analysisInterval: instrument.analysisInterval || input.config.analysis.interval,
    })),
    groups,
    quotes: Object.fromEntries(Object.entries(input.quotes).map(([key, quote]) => [key, serializeQuote(quote, input.config.display.staleAfterSeconds)])),
    agentAnalyses: {},
    openTrades: input.openTrades.map((trade) => tradeToPayload(trade)),
    exchangePositions: input.exchangePositions.map(positionToPayload),
    exchangeOrders: input.exchangeOrders.map(orderToPayload),
    recentNews: input.recentNews.map(newsItemToPayload),
    newsStatus: input.newsStatus ?? { enabled: input.config.news.enabled },
  };
}

export function serializeConfig(config: AppConfig): Record<string, unknown> {
  return {
    analysis: config.analysis,
    agent: {
      enabled: config.agent.enabled,
      provider: config.agent.provider,
      apiMode: config.agent.apiMode,
      model: config.agent.model,
      maxCandles: config.agent.maxCandles,
      candleContextMode: config.agent.candleContextMode,
      reasoningEffort: config.agent.reasoningEffort,
      providerProfiles: Object.fromEntries(
        Object.entries(config.agent.providerProfiles).map(([name, profile]) => [
          name,
          {
            enabled: profile.enabled,
            models: profile.models,
            modelEfforts: Object.fromEntries(profile.modelEfforts),
            baseUrl: profile.baseUrl || undefined,
            apiKeyConfigured: Boolean(profile.apiKey),
            apiKeyFromEnv: providerApiKeyFromEnv(name),
            customModels: profile.customModels,
          },
        ]),
      ),
    },
    display: config.display,
    news: config.news,
    memory: {
      enabled: config.memory.enabled,
      useMemories: config.memory.useMemories,
      generateMemories: config.memory.generateMemories,
      storagePath: config.memory.storagePath,
      extractModel: config.memory.extractModel,
      consolidationModel: config.memory.consolidationModel,
      maxRawMemories: config.memory.maxRawMemoriesForConsolidation,
      maxUnusedDays: config.memory.maxUnusedDays,
      maxSourceAgeDays: config.memory.maxSourceAgeDays,
      maxRolloutsPerStartup: config.memory.maxRolloutsPerStartup,
      minSessionIdleHours: config.memory.minSessionIdleHours,
      extensionRetentionDays: config.memory.extensionRetentionDays,
    },
    socialFeed: config.socialFeed,
    trading: config.trading,
    mcp: {
      enabled: config.mcp.enabled,
      configPath: config.mcp.configPath,
    },
    sourcePath: config.sourcePath,
  };
}

function providerApiKeyFromEnv(provider: string): boolean {
  if (provider === "anthropic") return Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
  return false;
}

function serializeQuote(quote: QuoteState, staleAfterSeconds: number): Record<string, unknown> {
  return {
    symbol: quote.symbol,
    displayName: quote.displayName,
    price: quote.price,
    priceLabel: quote.priceLabel(),
    change: quote.change,
    changePercent: quote.changePercent,
    changeLabel: quote.changeLabel(),
    percentLabel: quote.percentLabel(),
    previousClose: quote.previousClose,
    dayHigh: quote.dayHigh,
    dayLow: quote.dayLow,
    volume: quote.volume,
    volumeLabel: quote.volumeLabel(),
    currency: quote.currency,
    exchange: quote.exchange,
    status: quote.status,
    ageLabel: quote.ageLabel(),
    stale: quote.isStale(staleAfterSeconds),
    lastError: quote.lastError,
    updateCount: quote.updateCount,
  };
}
