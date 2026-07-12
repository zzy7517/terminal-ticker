import type { ToolRegistry } from "./registry.js";

const CLAUDE_READ_TOOLS = new Set([
  "browser_open_page", "browser_screenshot", "browser_status",
  "check_trade_status", "get_candles", "get_dealer_levels", "get_economic_calendar",
  "get_exchange_fills", "get_exchange_orders", "get_exchange_positions", "get_exposure_breakdown",
  "get_gamma_regime", "get_gex_by_strike", "get_gex_snapshot", "get_hedge_impulse", "get_jin10_quote",
  "get_options_flow", "get_pressure_cloud", "get_quote", "get_recent_news", "get_recent_social_feed",
  "get_trade_history", "get_trade_review_context", "list_instruments", "list_open_trades",
  "refresh_news", "refresh_x_following_feed", "search_x_tweets", "web_fetch", "web_search",
]);

export function exposeClaudeReadTools(registry: ToolRegistry): ToolRegistry {
  for (const tool of registry.listTools()) {
    if (!CLAUDE_READ_TOOLS.has(tool.name)) continue;
    registry.setPolicy(tool.name, {
      access: "read",
      domain: inferDomain(tool.name),
      runtimeExposure: ["pi", "claude-code"],
    });
  }
  return registry;
}

function inferDomain(name: string): "market" | "news" | "social" | "browser" | "trading" | "other" {
  if (name.startsWith("browser_")) return "browser";
  if (name.includes("news") || name.includes("jin10") || name.includes("economic")) return "news";
  if (name.includes("social") || name.includes("tweet") || name.includes("following")) return "social";
  if (name.includes("trade") || name.includes("exchange") || name.includes("position")) return "trading";
  if (name.includes("quote") || name.includes("candle") || name.includes("gex") || name.includes("gamma") || name.includes("options") || name.includes("pressure") || name.includes("exposure") || name.includes("hedge")) return "market";
  return "other";
}
