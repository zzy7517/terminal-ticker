import type { AgentConfig } from "../config/index.js";
import { buildBrowserTools } from "../agent/tools/browser.js";
import { createFilesystemRegistry } from "../agent/tools/filesystem.js";
import { buildJin10Tools } from "../agent/tools/jin10.js";
import { buildMarketTools } from "../agent/tools/market.js";
import { buildNewsTools } from "../agent/tools/news.js";
import { buildOptionsTools } from "../agent/tools/options.js";
import { mergeRegistries, type ToolRegistry } from "../agent/tools/registry.js";
import { buildSocialFeedTools } from "../agent/tools/social.js";
import { buildTradingTools } from "../agent/tools/trading.js";
import { buildWebTools } from "../agent/tools/web.js";
import { buildMcpToolRegistry } from "../mcp/index.js";
import type { AppRuntime } from "./runtime.js";

export interface TradexToolRegistryOptions {
  sessionId: string;
  config: AgentConfig;
  includeMemory: boolean;
  includeExternalMcp: boolean;
  includeFilesystem: boolean;
  additionalRegistries?: ToolRegistry[];
}

export async function buildTradexToolRegistry(runtime: AppRuntime, options: TradexToolRegistryOptions): Promise<{
  tools: ToolRegistry;
  externalContextToolNames: Set<string>;
}> {
  const mcpRegistry = options.includeExternalMcp && runtime.mcpManager
    ? await buildMcpToolRegistry(runtime.mcpManager, runtime.mcpManager.getConfig())
    : null;
  const memoryRegistry = options.includeMemory ? await runtime.memoryPort.buildTools() : null;
  const externalContextToolNames = new Set([
    "web_search", "web_fetch", "get_recent_news", "refresh_news",
    "refresh_x_following_feed", "get_recent_social_feed", "search_x_tweets",
    "browser_open_page", "browser_screenshot", "browser_status",
    ...(mcpRegistry?.listTools().map((tool) => tool.name) ?? []),
  ]);
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
    buildSocialFeedTools({
      refreshFollowing: (count) => runtime.socialFeedService.refreshXFollowing({ count }),
      recent: async (args) => runtime.socialFeedService.recentItems({
        limit: Number(args.limit) || runtime.config.socialFeed.recentLimit,
      }),
      search: async (args) => (await runtime.socialFeedService.searchXTweets({
        query: String(args.query || ""),
        count: Number(args.count) || 20,
        product: typeof args.product === "string" ? args.product : undefined,
      })).items,
    }),
    ...(memoryRegistry ? [memoryRegistry] : []),
    buildTradingTools({
      tradeStore: runtime.tradeStore,
      exchangeRouter: runtime.exchangeRouter,
      tradingConfig: runtime.config.trading,
      resolveSessionId: () => options.sessionId,
    }),
    buildJin10Tools(runtime.jin10Service),
    buildWebTools(),
    ...(runtime.config.browser.enabled ? [buildBrowserTools(runtime.browserManager)] : []),
    ...(runtime.optionsService ? [buildOptionsTools(runtime)] : []),
    ...(options.includeFilesystem ? [createFilesystemRegistry()] : []),
    ...(mcpRegistry ? [mcpRegistry] : []),
    ...(options.additionalRegistries ?? []),
  );
  return { tools, externalContextToolNames };
}
