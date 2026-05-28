/**
 * Data feeds API routes.
 */

import { Hono } from "hono";
import type { AppRuntime } from "../runtime.js";

export function feedsRoutes(runtime: AppRuntime): Hono {
  const app = new Hono();

  // GET /api/feeds/status — all feed statuses
  app.get("/api/feeds/status", (c) => {
    const statuses = runtime.dataFeeds?.statuses() ?? [];
    return c.json({ feeds: statuses });
  });

  // GET /api/feeds/snapshot — latest values from all feeds
  app.get("/api/feeds/snapshot", (c) => {
    const snapshot = runtime.dataFeeds?.snapshot() ?? {};
    return c.json(snapshot);
  });

  // GET /api/feeds/:name/latest — single feed latest value
  app.get("/api/feeds/:name/latest", (c) => {
    const name = c.req.param("name");
    const feed = runtime.dataFeeds?.get(name);
    if (!feed) return c.json({ error: "feed not found" }, 404);
    return c.json({ name, data: feed.getLatest() });
  });

  // GET /api/feeds/:name/history — single feed history
  app.get("/api/feeds/:name/history", (c) => {
    const name = c.req.param("name");
    const limit = Number(c.req.query("limit") ?? 50);
    const feed = runtime.dataFeeds?.get(name);
    if (!feed) return c.json({ error: "feed not found" }, 404);
    return c.json({ name, data: feed.getHistory(limit) });
  });

  return app;
}
