/** 构建 Pi 和 Claude 共用的规范 Tradex Tool Registry。 */
import type { AgentConfig } from "../config/index.js";
import { buildBrowserTools } from "../agent/tools/browser.js";
import { createFilesystemRegistry } from "../agent/tools/filesystem.js";
import { buildJin10Tools } from "../agent/tools/jin10.js";
import { buildMacroTools } from "../agent/tools/macro.js";
import { buildMarketTools } from "../agent/tools/market.js";
import { buildNewsTools } from "../agent/tools/news.js";
import { buildOptionsTools } from "../agent/tools/options.js";
import { mergeRegistries, type ToolRegistry } from "../agent/tools/registry.js";
import { buildTradingTools } from "../agent/tools/trading.js";
import { buildWebTools } from "../agent/tools/web.js";
import { buildMcpToolRegistry } from "../mcp/index.js";
import type { AppRuntime } from "./runtime.js";

export interface TradexToolRegistryOptions {
  sessionId: string;
  config: AgentConfig;
  includeExternalMcp: boolean;
  includeFilesystem: boolean;
  additionalRegistries?: ToolRegistry[];
  agentId?: string;
}

export async function buildTradexToolRegistry(runtime: AppRuntime, options: TradexToolRegistryOptions): Promise<{
  tools: ToolRegistry;
}> {
  const messageRegistry = options.agentId
    ? (await import("../chat/message-tools.js")).createMessageToolRegistry(runtime, options.agentId)
    : null;
  const mcpRegistry = options.includeExternalMcp && runtime.mcpManager
    ? await buildMcpToolRegistry(runtime.mcpManager, runtime.mcpManager.getConfig())
    : null;
  const tools = mergeRegistries(
    buildMarketTools({
      quotes: runtime.controller.quotes,
      maxCandles: options.config.maxCandles,
      candleContextMode: options.config.candleContextMode,
    }),
    buildNewsTools({
      recent: (limit, sinceMinutes) => runtime.newsService.recent(limit ?? undefined).filter((item) => (
        sinceMinutes == null || item.publishedAtMs >= Date.now() - sinceMinutes * 60_000
      )),
      refresh: () => runtime.newsService.refreshNow(),
    }),
    buildTradingTools({
      tradeStore: runtime.tradeStore,
      exchangeRouter: runtime.exchangeRouter,
      tradingConfig: runtime.config.trading,
      resolveSessionId: () => options.sessionId,
      checkEntryGate: () => runtime.macroService.checkEntryGate(),
    }),
    buildJin10Tools(runtime.jin10Service),
    buildWebTools(),
    ...(runtime.config.browser.enabled ? [buildBrowserTools(runtime.browserManager)] : []),
    ...(runtime.optionsService ? [buildOptionsTools(runtime)] : []),
    ...(runtime.macroService.available ? [buildMacroTools(runtime.macroService)] : []),
    ...(options.includeFilesystem ? [createFilesystemRegistry()] : []),
    ...(mcpRegistry ? [mcpRegistry] : []),
    ...(messageRegistry ? [messageRegistry] : []),
    ...(options.additionalRegistries ?? []),
  );
  return { tools };
}
