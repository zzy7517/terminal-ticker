import { ToolRegistry, jsonOutput } from "./registry.js";

export function buildSocialFeedTools(service: { refreshFollowing?: (count: number) => Promise<unknown>; recent?: (args: Record<string, unknown>) => Promise<unknown[]>; search?: (args: Record<string, unknown>) => Promise<unknown[]> } | null): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register({
    name: "refresh_x_following_feed",
    description: "Refresh X/Twitter following feed.",
    parameters: { type: "object", properties: { count: { type: "integer" } } },
    execute: async ({ count }) => jsonOutput(service?.refreshFollowing ? await service.refreshFollowing(Number(count) || 20) : { disabled: true }),
  });
  registry.register({
    name: "get_recent_social_feed",
    description: "Get recent social feed items.",
    parameters: { type: "object", properties: { limit: { type: "integer" } } },
    execute: async (args) => jsonOutput({ items: service?.recent ? await service.recent(args) : [] }),
  });
  registry.register({
    name: "search_x_tweets",
    description: "Search X/Twitter tweets.",
    parameters: { type: "object", properties: { query: { type: "string" }, count: { type: "integer" } }, required: ["query"] },
    execute: async (args) => jsonOutput({ items: service?.search ? await service.search(args) : [] }),
  });
  return registry;
}
