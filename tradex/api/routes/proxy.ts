import { Hono } from "hono";
import { updateProxyConfigInWatchlist } from "../../config/watchlist-store.js";
import { testProxyConfig } from "../../runtime/proxy.js";
import type { AppRuntime } from "../runtime.js";
import { mergeProxyConfig, requireConfigPath, reloadAndState } from "../helpers.js";

export function proxyRoutes(runtime: AppRuntime): Hono {
  const app = new Hono();

  // Persists outbound proxy configuration and reloads config so the new
  // dispatcher is applied live (reloadConfig calls applyProxyConfig).
  app.post("/api/proxy/config", async (c) => {
    try {
      const body = (await c.req.json()) as Record<string, unknown>;
      const merged = mergeProxyConfig(runtime.config.proxy, body);
      const watchlistPath = requireConfigPath(runtime);
      await updateProxyConfigInWatchlist(watchlistPath, merged);
      return c.json({ state: await reloadAndState(runtime, watchlistPath) });
    } catch (error) {
      return c.json({ detail: error instanceof Error ? error.message : String(error) }, 400);
    }
  });

  // Probes a proxy without persisting or touching the global dispatcher. Uses
  // the submitted form values (falling back to the saved config) so the user
  // can verify before saving.
  app.post("/api/proxy/test", async (c) => {
    try {
      const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
      const candidate = mergeProxyConfig({ ...runtime.config.proxy, enabled: true }, { ...body, enabled: true });
      const testUrl = typeof body.testUrl === "string" && body.testUrl.trim() ? body.testUrl.trim() : undefined;
      const result = await testProxyConfig(candidate, testUrl);
      return c.json(result);
    } catch (error) {
      return c.json({ ok: false, error: error instanceof Error ? error.message : String(error) }, 400);
    }
  });

  return app;
}
