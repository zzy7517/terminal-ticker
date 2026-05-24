import { Hono } from "hono";
import type { AppRuntime } from "../runtime.js";

export function browserRoutes(runtime: AppRuntime): Hono {
  const app = new Hono();

  /** Get browser automation status */
  app.get("/api/browser/status", async (c) => {
    const status = await runtime.browserManager.status();
    return c.json(status);
  });

  /** Ping the OBU native host to verify it's reachable */
  app.post("/api/browser/ping", async (c) => {
    const result = await runtime.browserManager.ping();
    return c.json(result);
  });

  /** Update browser settings (enable/disable, socket path, timeout) */
  app.post("/api/browser/settings", async (c) => {
    const body = await c.req.json<{
      enabled?: boolean;
      socketPath?: string | null;
      timeoutMs?: number;
    }>();

    const current = runtime.config.browser;
    const updated = {
      enabled: body.enabled ?? current.enabled,
      socketPath: body.socketPath !== undefined ? (body.socketPath || null) : current.socketPath,
      timeoutMs: body.timeoutMs ?? current.timeoutMs,
    };

    runtime.config = { ...runtime.config, browser: updated };
    runtime.browserManager.updateConfig(updated);

    return c.json({ ok: true, browser: updated });
  });

  return app;
}
