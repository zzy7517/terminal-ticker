import { Hono } from "hono";
import { updateNewsConfigInWatchlist } from "../../config/watchlist_store.js";
import { newsItemToPayload } from "../../news/types.js";
import type { AppRuntime } from "../runtime.js";
import { requireConfigPath, reloadAndState, mergeNewsConfig } from "../helpers.js";

export function newsRoutes(runtime: AppRuntime): Hono {
  const app = new Hono();

  // Persists news feed configuration changes and reloads config.
  app.post("/api/news/config", async (c) => {
    try {
      const body = (await c.req.json()) as Record<string, unknown>;
      const watchlistPath = requireConfigPath(runtime);
      await updateNewsConfigInWatchlist(watchlistPath, mergeNewsConfig(runtime.config.news, body));
      return c.json({ state: await reloadAndState(runtime, watchlistPath) });
    } catch (error) {
      return c.json({ detail: error instanceof Error ? error.message : String(error) }, 400);
    }
  });

  // Triggers an immediate out-of-band news fetch and returns the refreshed items.
  app.post("/api/news/refresh", async (c) => {
    const outcome = await runtime.newsService.refreshNow();
    const news = runtime.newsService.recent();
    return c.json({ ...outcome, totalRecent: news.length, stale: outcome.status !== "ok", news: news.map(newsItemToPayload) });
  });

  return app;
}
