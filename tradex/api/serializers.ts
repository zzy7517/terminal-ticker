import { AppConfig } from "../config/index.js";
import { QuoteState } from "../domain/quotes.js";
import { MarketInstrument } from "../market_data/router.js";
import { ExchangeOrder, ExchangePosition, orderToPayload, positionToPayload } from "../trading/exchange_models.js";
import { Trade, tradeToPayload } from "../trading/models.js";
import { NewsItem, newsItemToPayload } from "../news/types.js";
import type { Jin10CalendarEvent, Jin10Quote, Jin10Status } from "../jin10/types.js";

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
  jin10?: {
    status: Jin10Status;
    calendar: Jin10CalendarEvent[];
    quotes: Jin10Quote[];
  };
  options?: {
    snapshots: Record<string, unknown>;
  } | null;
}): Record<string, unknown> {
  const groups: Record<string, string[]> = {};
  for (const instrument of input.instruments) {
    const group = instrument.source || "other";
    groups[group] = [...(groups[group] ?? []), instrument.key];
  }

  // Determine whether instruments from a given source support agent analysis
  // (candles, multi-timeframe). Sources that only provide quote snapshots are not analysable.
  const sourceAnalysable = resolveSourceAnalysable(input.config);

  // Build base instruments and quotes
  const instruments = input.instruments.map((instrument) => ({
    key: instrument.key,
    symbol: instrument.symbol,
    label: instrument.label,
    source: instrument.source,
    instType: "instType" in instrument ? instrument.instType : null,
    group: instrument.group,
    analysisInterval: instrument.analysisInterval || input.config.analysis.interval,
    analysable: sourceAnalysable(instrument.source),
  }));
  const quotes: Record<string, unknown> = Object.fromEntries(
    Object.entries(input.quotes).map(([key, quote]) => [key, serializeQuote(quote, input.config.display.staleAfterSeconds)]),
  );

  // Inject Jin10 quotes into watchlist when available
  if (input.jin10 && input.jin10.quotes.length > 0) {
    const jin10Keys: string[] = [];
    for (const q of input.jin10.quotes) {
      const key = `jin10:${q.code}`;
      jin10Keys.push(key);
      instruments.push({
        key,
        symbol: q.code,
        label: q.name || q.code,
        source: "jin10",
        instType: null,
        group: "jin10",
        analysisInterval: "",
        analysable: sourceAnalysable("jin10"),
      });
      quotes[key] = serializeJin10Quote(q);
    }
    groups["jin10"] = jin10Keys;
  }

  return {
    type: "state",
    updatedAt: new Date().toISOString(),
    streamStatus: input.streamStatus,
    config: serializeConfig(input.config),
    instruments,
    groups,
    quotes,
    agentAnalyses: {},
    openTrades: input.openTrades.map((trade) => tradeToPayload(trade)),
    exchangePositions: input.exchangePositions.map(positionToPayload),
    exchangeOrders: input.exchangeOrders.map(orderToPayload),
    recentNews: input.recentNews.map(newsItemToPayload),
    newsStatus: input.newsStatus ?? { enabled: input.config.news.enabled },
    jin10: input.jin10 ?? null,
    options: input.options ?? null,
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
      disableOnExternalContext: config.memory.disableOnExternalContext,
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
    jin10: {
      enabled: config.jin10.enabled,
      tokenConfigured: Boolean(config.jin10.token),
      flashEnabled: config.jin10.flashEnabled,
      calendarEnabled: config.jin10.calendarEnabled,
      quotesEnabled: config.jin10.quotesEnabled,
      quotesCodes: config.jin10.quotesCodes,
    },
    options: {
      enabled: config.options.enabled,
      provider: config.options.provider,
      symbols: config.options.symbols,
      pollIntervalSeconds: config.options.pollIntervalSeconds,
      strikeRangePercent: config.options.strikeRangePercent,
      tradier: config.options.tradier ? {
        apiKeyConfigured: Boolean(config.options.tradier.apiKey),
        baseUrl: config.options.tradier.baseUrl,
      } : undefined,
      deribit: config.options.deribit,
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

function serializeJin10Quote(q: Jin10Quote): Record<string, unknown> {
  const sign = q.change >= 0 ? "+" : "";
  const pctSign = q.changePercent >= 0 ? "+" : "";
  return {
    symbol: q.code,
    displayName: q.name || q.code,
    price: q.close,
    priceLabel: q.close ? formatJin10Price(q.close) : "-",
    change: q.change,
    changePercent: q.changePercent,
    changeLabel: `${sign}${q.change.toFixed(2)}`,
    percentLabel: `${pctSign}${q.changePercent.toFixed(2)}%`,
    previousClose: null,
    dayHigh: q.high,
    dayLow: q.low,
    volume: q.volume,
    volumeLabel: q.volume ? String(q.volume) : "-",
    currency: "",
    exchange: "jin10",
    status: q.time ? "active" : "idle",
    ageLabel: q.time || "-",
    stale: false,
    lastError: null,
    updateCount: 0,
  };
}

function formatJin10Price(price: number): string {
  if (price >= 100) return price.toFixed(2);
  if (price >= 1) return price.toFixed(4);
  return price.toFixed(5);
}

/**
 * Returns a predicate that determines whether instruments from a given source
 * support agent analysis (candles, multi-timeframe context).
 *
 * Policy:
 * - Sources with candle data (bitget, hyperliquid) default to true
 * - Quote-only sources (jin10) default to false
 * - Each source's config can override via `agent_analysis` field
 */
function resolveSourceAnalysable(config: AppConfig): (source: string) => boolean {
  // Build a source → analysable lookup from config.
  // Default is true for data sources that natively provide candles.
  const overrides: Record<string, boolean> = {
    jin10: config.jin10.agentAnalysis,
  };

  return (source: string): boolean => {
    if (source in overrides) return overrides[source];
    // Bitget, Hyperliquid, and any future candle-capable sources default to true
    return true;
  };
}
