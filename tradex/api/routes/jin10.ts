import { Hono } from "hono";
import { updateJin10ConfigInWatchlist } from "../../config/watchlist_store.js";
import type { AppRuntime } from "../runtime.js";
import { requireConfigPath, reloadAndState } from "../helpers.js";

export function jin10Routes(runtime: AppRuntime): Hono {
  const app = new Hono();

  // Current Jin10 status (availability, connection, module states).
  app.get("/api/jin10/status", (c) => {
    return c.json(runtime.jin10Service.getStatus());
  });

  // Current calendar events.
  app.get("/api/jin10/calendar", (c) => {
    return c.json({ events: runtime.jin10Service.getCalendar() });
  });

  // Current quotes snapshot.
  app.get("/api/jin10/quotes", (c) => {
    return c.json({ quotes: runtime.jin10Service.getQuotes() });
  });

  // Force refresh flash news.
  app.post("/api/jin10/flash/refresh", async (c) => {
    const result = await runtime.jin10Service.refreshFlash();
    return c.json(result);
  });

  // Force refresh calendar.
  app.post("/api/jin10/calendar/refresh", async (c) => {
    const result = await runtime.jin10Service.refreshCalendar();
    return c.json(result);
  });

  // Force refresh quotes.
  app.post("/api/jin10/quotes/refresh", async (c) => {
    const result = await runtime.jin10Service.refreshQuotes();
    return c.json(result);
  });

  // Fetch available quote codes from jin10 MCP resource (quote://codes).
  // Returns [{code, name}] pairs from jin10 MCP resource.
  app.get("/api/jin10/available-codes", async (c) => {
    try {
      if (!runtime.jin10Service.available) return c.json({ codes: [] });
      const result = await runtime.jin10Service.readResource("quote://codes");
      const textParts = (result.contents as Array<{ type?: string; text?: string }>)
        .filter((content) => content.text)
        .map((content) => content.text!);
      const raw = textParts.join("\n");
      let codes: Array<{ code: string; name: string }> = [];
      try {
        const parsed = JSON.parse(raw);
        const arr: unknown[] = Array.isArray(parsed) ? parsed : (parsed.data && Array.isArray(parsed.data) ? parsed.data : []);
        codes = arr
          .filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null)
          .map((item) => ({ code: String(item.code ?? ""), name: String(item.name ?? item.code ?? "") }))
          .filter((item) => item.code);
      } catch {
        codes = raw.split(/[\n,]/).map((s) => s.trim()).filter(Boolean).map((s) => ({ code: s, name: s }));
      }
      return c.json({ codes });
    } catch (error) {
      return c.json({ codes: [], error: error instanceof Error ? error.message : String(error) });
    }
  });

  // Update Jin10 config (token, enabled flags, codes, etc.) and persist to TOML.
  app.post("/api/jin10/config", async (c) => {
    try {
      const body = (await c.req.json()) as Record<string, unknown>;
      const watchlistPath = requireConfigPath(runtime);
      const current = runtime.config.jin10;
      const next = {
        ...current,
        ...(typeof body.enabled === "boolean" ? { enabled: body.enabled } : {}),
        // A new token replaces both the resolved value and the raw form, so the
        // stale "${JIN10_TOKEN}" reference cannot shadow it on save; the store
        // interns the literal into the secrets vault before touching the TOML.
        ...(typeof body.token === "string" ? { token: body.token.trim(), tokenRaw: body.token.trim() } : {}),
        ...(typeof body.flash_enabled === "boolean" ? { flashEnabled: body.flash_enabled } : {}),
        ...(typeof body.calendar_enabled === "boolean" ? { calendarEnabled: body.calendar_enabled } : {}),
        ...(typeof body.quotes_enabled === "boolean" ? { quotesEnabled: body.quotes_enabled } : {}),
        ...(Array.isArray(body.quotes_codes) ? { quotesCodes: body.quotes_codes.map((c: unknown) => String(c).trim().toUpperCase()).filter(Boolean) } : {}),
      };
      await updateJin10ConfigInWatchlist(watchlistPath, next);
      return c.json({ state: await reloadAndState(runtime, watchlistPath) });
    } catch (error) {
      return c.json({ detail: error instanceof Error ? error.message : String(error) }, 400);
    }
  });

  return app;
}
