import { Hono } from "hono";
import { updateSocialFeedConfigInWatchlist } from "../../config/watchlist_store.js";
import { importXAuthFromBrowser } from "../../social_feed/browser_auth.js";
import { socialItemToPayload } from "../../social_feed/types.js";
import type { AppRuntime } from "../runtime.js";
import { requireConfigPath, reloadAndState, mergeSocialFeedConfig } from "../helpers.js";

export function socialRoutes(runtime: AppRuntime): Hono {
  const app = new Hono();

  // Persists social feed configuration changes and reloads config.
  app.post("/api/social/config", async (c) => {
    try {
      const body = (await c.req.json()) as Record<string, unknown>;
      const watchlistPath = requireConfigPath(runtime);
      await updateSocialFeedConfigInWatchlist(watchlistPath, mergeSocialFeedConfig(runtime.config.socialFeed, body));
      return c.json({ state: await reloadAndState(runtime, watchlistPath) });
    } catch (error) {
      return c.json({ detail: error instanceof Error ? error.message : String(error) }, 400);
    }
  });

  // Returns the current X (Twitter) auth token status.
  app.get("/api/social/auth", (c) => c.json(runtime.xAuthStore.status()));

  // Saves X auth credentials (authToken + ct0 cookie) to the local store.
  app.post("/api/social/auth", async (c) => {
    const body = (await c.req.json()) as Record<string, unknown>;
    return c.json(runtime.xAuthStore.save({ authToken: String(body.authToken || ""), ct0: String(body.ct0 || "") }));
  });

  // Imports X auth cookies from the user's logged-in Chrome profile via OBU.
  app.post("/api/social/auth/import-browser", async (c) =>
    c.json(await importXAuthFromBrowser({ browserManager: runtime.browserManager, authStore: runtime.xAuthStore })),
  );

  // Clears stored X auth credentials.
  app.delete("/api/social/auth", (c) => c.json(runtime.xAuthStore.clear()));

  // Fetches the latest posts from followed X accounts and caches them.
  app.post("/api/social/x/refresh", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const outcome = await runtime.socialFeedService.refreshXFollowing({ count: Number(body.count) || 3 });
    return c.json({ ...outcome, totalRecent: runtime.socialFeedService.recentItems().length });
  });

  // Returns recent social feed items up to the requested limit.
  app.get("/api/social/feed", (c) => {
    const limit = Number(c.req.query("limit") || 3);
    return c.json({ items: runtime.socialFeedService.recentItems({ limit }).map((item) => socialItemToPayload(item)) });
  });

  return app;
}
