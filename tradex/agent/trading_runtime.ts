import { AgentConfig, TradingConfig } from "../config/index.js";
import { ExchangeRouter } from "../trading/exchange_router.js";
import { TradeStore } from "../trading/store.js";
import { AgentLoop, LoopResult } from "./loop.js";
import { DEFAULT_AGENT_MODEL_REGISTRY, AgentModelRegistry } from "./model_registry.js";
import { buildTradingTools } from "./tools/trading.js";

export interface TradingAgentRuntimeServices {
  tradeStore: TradeStore;
  exchangeRouter: ExchangeRouter;
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

  async runTurn(input: { userMessage: string; history?: Array<Record<string, unknown>>; sessionId?: string | null }): Promise<TradingAgentTurnResult> {
    const provider = this.registry.createProvider(this.config);
    const tools = buildTradingTools({ tradeStore: this.services.tradeStore, exchangeRouter: this.services.exchangeRouter, resolveSessionId: () => input.sessionId ?? null });
    const loop = new AgentLoop({ provider, tools, systemPrompt: this.buildSystemPrompt() });
    return { result: await loop.run({ userMessage: input.userMessage, conversationHistory: input.history ?? [] }), sessionId: input.sessionId ?? null };
  }

  private buildSystemPrompt(): string {
    const permissions = [
      this.tradingConfig.hyperliquidEnabled ? "Hyperliquid trading enabled" : "Hyperliquid trading disabled",
      this.tradingConfig.bitgetDemoEnabled ? "Bitget demo trading enabled" : "Bitget demo trading disabled",
    ].join("; ");
    return `你是交易 agent。执行任何下单/平仓前必须确认工具和配置允许。${permissions}`;
  }
}
