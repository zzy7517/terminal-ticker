import { ToolRegistry, jsonOutput } from "./registry.js";

export function buildNewsTools(newsService: { recent?: (limit: number, sinceMinutes?: number | null) => Promise<unknown[]> | unknown[]; refresh?: () => Promise<unknown> | unknown } | null): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register({
    name: "get_recent_news",
    description: "Get recent market news.",
    parameters: { type: "object", properties: { limit: { type: "integer" }, since_minutes: { type: ["integer", "null"] } } },
    execute: async ({ limit, since_minutes }) => {
      if (!newsService?.recent) return jsonOutput({ disabled: true, items: [] });
      return jsonOutput({ items: await newsService.recent(Number(limit) || 10, since_minutes === null ? null : Number(since_minutes ?? 120)) });
    },
  });
  registry.register({
    name: "refresh_news",
    description: "Refresh the news feed.",
    parameters: { type: "object", properties: {} },
    execute: async () => jsonOutput({ result: newsService?.refresh ? await newsService.refresh() : null }),
  });
  return registry;
}
