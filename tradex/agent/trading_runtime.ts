import { AgentConfig, TradingConfig } from "../config/index.js";
import { QuoteState } from "../domain/quotes.js";
import { ExchangeRouter } from "../trading/exchange_router.js";
import { TradeStore } from "../trading/store.js";
import { buildMemoryDeveloperInstructions } from "../memory/read/prompts.js";
import { AgentLoop, AgentEventHandler, LoopResult } from "./loop.js";
import { DEFAULT_AGENT_MODEL_REGISTRY, AgentModelRegistry } from "./model_registry.js";
import { mergeRegistries } from "./tools/registry.js";
import { buildMarketTools } from "./tools/market.js";
import { buildNewsTools } from "./tools/news.js";
import { buildSocialFeedTools } from "./tools/social.js";
import { buildMemoryTools } from "../memory/tools.js";
import { buildTradingTools } from "./tools/trading.js";
import { buildWebTools } from "./tools/web.js";

export interface TradingAgentNewsService {
  recent: (limit: number, sinceMinutes?: number | null) => Promise<unknown[]> | unknown[];
  refresh: () => Promise<unknown> | unknown;
}

export interface TradingAgentSocialService {
  refreshFollowing: (count: number) => Promise<unknown>;
  recent: (args: Record<string, unknown>) => Promise<unknown[]>;
  search: (args: Record<string, unknown>) => Promise<unknown[]>;
}

export interface TradingAgentRuntimeServices {
  tradeStore: TradeStore;
  exchangeRouter: ExchangeRouter;
  newsService?: TradingAgentNewsService | null;
  socialFeedService?: TradingAgentSocialService | null;
  memoryStoragePath?: string | null;
  quotes?: Record<string, QuoteState> | null;
  captureSnapshot?: ((instrumentKey: string) => number | null) | null;
}

export interface TradingAgentTurnResult {
  result: LoopResult;
  sessionId: string | null;
}

export class TradingAgentRuntime {
  readonly config: AgentConfig;
  readonly tradingConfig: TradingConfig;
  readonly services: TradingAgentRuntimeServices;
  readonly registry: AgentModelRegistry;

  constructor(input: { config: AgentConfig; tradingConfig: TradingConfig; services: TradingAgentRuntimeServices; registry?: AgentModelRegistry }) {
    this.config = input.config;
    this.tradingConfig = input.tradingConfig;
    this.services = input.services;
    this.registry = input.registry ?? DEFAULT_AGENT_MODEL_REGISTRY;
  }

  async runTurn(input: {
    userMessage: string;
    history?: Array<Record<string, unknown>>;
    sessionId?: string | null;
    eventHandler?: AgentEventHandler | null;
  }): Promise<TradingAgentTurnResult> {
    const provider = this.registry.createProvider(this.config);
    const tools = mergeRegistries(
      ...(this.services.quotes ? [buildMarketTools({ quotes: this.services.quotes, maxCandles: this.config.maxCandles })] : []),
      buildNewsTools(this.services.newsService ?? null),
      buildSocialFeedTools(this.services.socialFeedService ?? null),
      ...(this.services.memoryStoragePath ? [buildMemoryTools(this.services.memoryStoragePath)] : []),
      buildTradingTools({
        tradeStore: this.services.tradeStore,
        exchangeRouter: this.services.exchangeRouter,
        tradingConfig: this.tradingConfig,
        resolveSessionId: () => input.sessionId ?? null,
        captureSnapshot: this.services.captureSnapshot ?? null,
      }),
      buildWebTools(),
    );
    const loop = new AgentLoop({ provider, tools, systemPrompt: this.buildSystemPrompt() });
    return {
      result: await loop.run({
        userMessage: input.userMessage,
        conversationHistory: input.history ?? [],
        eventHandler: input.eventHandler ?? null,
      }),
      sessionId: input.sessionId ?? null,
    };
  }

  private buildSystemPrompt(): string {
    const permissions = [
      this.tradingConfig.hyperliquidEnabled ? "Hyperliquid trading enabled" : "Hyperliquid trading disabled",
      this.tradingConfig.bitgetDemoEnabled ? "Bitget demo trading enabled" : "Bitget demo trading disabled",
    ].join("; ");
    let prompt = `你是一名做加密货币永续合约的职业 trader，擅长 price action 与 Smart Money Concepts，习惯用衍生品数据交叉验证判断。默认中文，结论先于论据；涉及行情、K 线、持仓、成交、新闻的事实判断必须先调工具。\n\n执行任何下单/平仓前必须确认工具和配置允许。${permissions}`;
    if (this.services.memoryStoragePath) {
      const memoryInstructions = buildMemoryDeveloperInstructions(this.services.memoryStoragePath);
      if (memoryInstructions) prompt += "\n\n" + memoryInstructions;
    }
    return prompt;
  }
}
