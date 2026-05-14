/**
 * trading_runtime.ts — Entry point for the Trading Agent runtime.
 *
 * Responsibility: assemble all external services (quotes, news, social,
 * memory, exchanges) into a unified tool registry, pair it with an LLM
 * model descriptor, and drive one conversation turn through the tool-calling loop.
 *
 * Uses the new AgentModel + API Registry pattern: model is a pure value object,
 * switching mid-session is just setModel(newModel).
 */

import { AgentConfig, TradingConfig } from "../config/index.js";
import { QuoteState } from "../domain/quotes.js";
import { ExchangeRouter } from "../trading/exchange_router.js";
import { TradeStore } from "../trading/store.js";
import { buildMemoryDeveloperInstructions } from "../memory/read/prompts.js";
import type { AgentModel } from "./models.js";
import { resolveAgentModelFromConfig } from "./models.js";
import { AgentLoop, AgentEventHandler, LoopResult } from "./loop.js";
import { mergeRegistries } from "./tools/registry.js";
import { buildMarketTools } from "./tools/market.js";
import { buildNewsTools } from "./tools/news.js";
import { buildSocialFeedTools } from "./tools/social.js";
import { buildMemoryTools } from "../memory/tools.js";
import { buildTradingTools } from "./tools/trading.js";
import { buildWebTools } from "./tools/web.js";

// Ensure built-in providers are registered
import "./providers/register.js";

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
 *
 * Holds a mutable `currentModel` that can be swapped between turns.
 */
export class TradingAgentRuntime {
  readonly config: AgentConfig;
  readonly tradingConfig: TradingConfig;
  readonly services: TradingAgentRuntimeServices;
  private _model: AgentModel;

  constructor(input: { config: AgentConfig; tradingConfig: TradingConfig; services: TradingAgentRuntimeServices; model?: AgentModel }) {
    this.config = input.config;
    this.tradingConfig = input.tradingConfig;
    this.services = input.services;
    this._model = input.model ?? resolveAgentModelFromConfig(input.config);
  }

  /** Current model descriptor. */
  get model(): AgentModel {
    return this._model;
  }

  /** Switch to a different model. Takes effect on the next runTurn() call. */
  setModel(model: AgentModel): void {
    this._model = model;
  }

  /**
   * Execute one conversation turn.
   */
  async runTurn(input: {
    userMessage: string;
    history?: Array<Record<string, unknown>>;
    sessionId?: string | null;
    eventHandler?: AgentEventHandler | null;
  }): Promise<TradingAgentTurnResult> {
    // Assemble the tool registry from individual tool packs.
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

    // Create the loop with current model and run it
    const loop = new AgentLoop({ model: this._model, tools, systemPrompt: this.buildSystemPrompt() });
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
   */
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
