/**
 * trading_runtime.ts — Entry point for the Trading Agent runtime.
 *
 * Responsibility: assemble all external services (quotes, news, social,
 * memory, exchanges) into a unified tool registry, pair it with an LLM
 * provider, and drive one conversation turn through the tool-calling loop.
 *
 * Callers (e.g. api/runtime.ts) only need to construct a
 * TradingAgentRuntime and call runTurn() to execute the full cycle:
 *   user message -> multi-step tool calls -> final assistant response.
 */

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

/**
 * Social-feed service contract (currently backed by X / Twitter).
 */
export interface TradingAgentSocialService {
  refreshFollowing: (count: number) => Promise<unknown>;
  recent: (args: Record<string, unknown>) => Promise<unknown[]>;
  search: (args: Record<string, unknown>) => Promise<unknown[]>;
}

/**
 * Aggregate of every external service the Runtime needs.
 */
export interface TradingAgentRuntimeServices {
  tradeStore: TradeStore;
  exchangeRouter: ExchangeRouter;
  newsService?: TradingAgentNewsService | null;
  socialFeedService?: TradingAgentSocialService | null;
  memoryStoragePath?: string | null;
  quotes?: Record<string, QuoteState> | null;
  captureSnapshot?: ((instrumentKey: string) => number | null) | null;
}

/**
 * Return value of a single conversation turn.
 */
export interface TradingAgentTurnResult {
  result: LoopResult;
  sessionId: string | null;
}

/**
 * TradingAgentRuntime — the top-level orchestrator.
 */
export class TradingAgentRuntime {
  readonly config: AgentConfig;
  readonly tradingConfig: TradingConfig;
  readonly services: TradingAgentRuntimeServices;
  /** Model registry used to resolve which LLM provider + model to call. */
  readonly registry: AgentModelRegistry;

  /**
   * Construct a new runtime.
   *
   * @param config         Agent-level settings (model name, max candles, etc.)
   * @param tradingConfig  Trading switches (which exchanges are enabled).
   * @param services       All injected external services (see TradingAgentRuntimeServices).
   * @param registry       Optional custom model registry; defaults to the built-in
   *                       DEFAULT_AGENT_MODEL_REGISTRY which knows Codex + Anthropic.
   */
  constructor(input: { config: AgentConfig; tradingConfig: TradingConfig; services: TradingAgentRuntimeServices; registry?: AgentModelRegistry }) {
    this.config = input.config;
    this.tradingConfig = input.tradingConfig;
    this.services = input.services;
    this.registry = input.registry ?? DEFAULT_AGENT_MODEL_REGISTRY;
  }

  /**
   * Execute one conversation turn.
   *
   * @param userMessage  The user's latest chat message.
   * @param history      Previous conversation turns (for multi-turn context).
   * @param sessionId    Current session ID (passed into trading tools for snapshot association).
   * @param eventHandler Optional callback that receives streaming events (tool calls, deltas, etc.).
   */
  async runTurn(input: {
    userMessage: string;
    history?: Array<Record<string, unknown>>;
    sessionId?: string | null;
    eventHandler?: AgentEventHandler | null;
  }): Promise<TradingAgentTurnResult> {
    // Step 1: resolve LLM provider from registry (e.g. Codex gpt-5.5 or Anthropic Claude Opus)
    const provider = this.registry.createProvider(this.config);

    // Step 2: assemble the tool registry from individual tool packs.
    // Each build*() returns a ToolRegistry; mergeRegistries() combines them into one.
    // Conditional spreads ensure tools are only registered when their backing service exists.
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

    // Step 3 + 4: create the loop with system prompt and run it
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

  /**
   * Build the system prompt injected at the start of every conversation.
   *
   */
  private buildSystemPrompt(): string {
    // Summarize which exchange platforms are on/off
    const permissions = [
      this.tradingConfig.hyperliquidEnabled ? "Hyperliquid trading enabled" : "Hyperliquid trading disabled",
      this.tradingConfig.bitgetDemoEnabled ? "Bitget demo trading enabled" : "Bitget demo trading disabled",
    ].join("; ");

    // Core persona + permission line
    let prompt = `你是一名做加密货币永续合约的职业 trader，擅长 price action 与 Smart Money Concepts，习惯用衍生品数据交叉验证判断。默认中文，结论先于论据；涉及行情、K 线、持仓、成交、新闻的事实判断必须先调工具。\n\n执行任何下单/平仓前必须确认工具和配置允许。${permissions}`;

    // Append memory-related developer instructions when memory is enabled
    if (this.services.memoryStoragePath) {
      const memoryInstructions = buildMemoryDeveloperInstructions(this.services.memoryStoragePath);
      if (memoryInstructions) prompt += "\n\n" + memoryInstructions;
    }
    return prompt;
  }
}
