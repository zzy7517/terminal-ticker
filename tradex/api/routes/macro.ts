/**
 * Macro data layer — API routes.
 *
 * Endpoints:
 *   GET  /api/macro/status                     — per-series freshness + calendar state
 *   GET  /api/macro/snapshot?window_days=&at=  — descriptive snapshot + derived metrics
 *   GET  /api/macro/series                     — registry of known series
 *   GET  /api/macro/series/:seriesId?as_of=    — one series, vintage-aware
 *   GET  /api/macro/events?from=&to=           — persisted economic calendar
 *   GET  /api/macro/event-window?at=           — release-silence verdict
 *   POST /api/macro/refresh?source=            — force a sweep
 *   POST /api/macro/config                     — update [macro] config
 *
 * Every read accepts `as_of` / `at` so a caller can reproduce what was knowable
 * at a past instant instead of only seeing the latest revision.
 */

import { Hono } from "hono";
import { updateMacroConfigInWatchlist } from "../../config/watchlist-store.js";
import type { MacroConfig, MacroEventImpact } from "../../macro/domain.js";
import { MACRO_SERIES, findSeries } from "../../macro/registry.js";
import type { AppRuntime } from "../runtime.js";
import { requireConfigPath, reloadAndState } from "../helpers.js";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Parse an epoch-ms query param, ignoring junk rather than erroring. */
function parseMs(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

function parseImpact(raw: string | undefined): MacroEventImpact | undefined {
  return raw === "high" || raw === "medium" || raw === "low" ? raw : undefined;
}

export function macroRoutes(runtime: AppRuntime): Hono {
  const app = new Hono();

  app.get("/api/macro/status", (c) => c.json(runtime.macroService.getStatus()));

  app.get("/api/macro/snapshot", (c) => {
    const windowDaysRaw = Number(c.req.query("window_days"));
    return c.json(
      runtime.macroService.getSnapshot({
        atMs: parseMs(c.req.query("at")),
        windowDays: Number.isFinite(windowDaysRaw) && windowDaysRaw > 0 ? windowDaysRaw : undefined,
      }),
    );
  });

  // Registry only — no I/O. Lets the UI render a series picker before any data
  // has been collected.
  app.get("/api/macro/series", (c) => c.json({ series: MACRO_SERIES }));

  app.get("/api/macro/series/:seriesId", (c) => {
    const seriesId = c.req.param("seriesId");
    const meta = findSeries(seriesId);
    if (!meta) return c.json({ error: `Unknown series: ${seriesId}` }, 404);

    const limitRaw = Number(c.req.query("limit"));
    const points = runtime.macroService.getSeries(seriesId, {
      asOfMs: parseMs(c.req.query("as_of")),
      fromMs: parseMs(c.req.query("from")),
      limit: Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 5000) : undefined,
    });
    return c.json({ meta, points, count: points.length });
  });

  app.get("/api/macro/events", (c) => {
    const now = Date.now();
    const events = runtime.macroService.getEvents({
      fromMs: parseMs(c.req.query("from")) ?? now - 2 * DAY_MS,
      toMs: parseMs(c.req.query("to")) ?? now + 7 * DAY_MS,
      minImpact: parseImpact(c.req.query("min_impact")),
    });
    return c.json({ events, count: events.length, fresh: runtime.macroService.calendarFresh });
  });

  app.get("/api/macro/event-window", (c) => {
    const atMs = parseMs(c.req.query("at")) ?? Date.now();
    const gate = runtime.macroService.checkEntryGate(atMs);
    return c.json({ atMs, ...gate.verdict, blocked: gate.blocked, reason: gate.reason });
  });

  // POST /api/macro/refresh — force one sweep. Useful right after configuring a
  // key, so the user does not have to wait out the poll interval.
  app.post("/api/macro/refresh", async (c) => {
    const source = c.req.query("source") ?? "all";
    const svc = runtime.macroService;
    if (!svc.available) return c.json({ error: "Macro layer not enabled" }, 503);

    try {
      switch (source) {
        case "fred":
          return c.json({ source, ...(await svc.refreshFred()) });
        case "calendar":
          return c.json({ source, ...(await svc.refreshCalendar()) });
        case "crypto":
          return c.json({ source, ...(await svc.refreshCrypto()) });
        case "quotes":
          return c.json({ source, ...(await svc.refreshQuotes()) });
        case "all": {
          const [fred, crypto, quotes, calendar] = await Promise.all([
            svc.refreshFred(),
            svc.refreshCrypto(),
            svc.refreshQuotes(),
            svc.refreshCalendar(),
          ]);
          return c.json({ source, fred, crypto, quotes, calendar });
        }
        default:
          return c.json({ error: `Unknown source: ${source}` }, 400);
      }
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 500);
    }
  });

  app.post("/api/macro/config", async (c) => {
    try {
      const body = (await c.req.json()) as Record<string, unknown>;
      const watchlistPath = requireConfigPath(runtime);
      const current = runtime.config.macro;
      const window = (body.event_window ?? {}) as Record<string, unknown>;

      const bool = (value: unknown, fallback: boolean): boolean =>
        typeof value === "boolean" ? value : fallback;
      const int = (value: unknown, fallback: number, min: number): number =>
        typeof value === "number" && Number.isFinite(value) ? Math.max(Math.trunc(value), min) : fallback;
      const str = (value: unknown, fallback: string): string =>
        typeof value === "string" ? value.trim() : fallback;

      // A newly posted key replaces both the resolved value and the raw form;
      // the watchlist store interns literals into the secrets vault on save.
      const fredKey = typeof body.fred_api_key === "string" ? body.fred_api_key.trim() : null;
      const twelveKey = typeof body.twelve_data_api_key === "string" ? body.twelve_data_api_key.trim() : null;

      const merged: MacroConfig = {
        enabled: bool(body.enabled, current.enabled),
        fredApiKey: fredKey ?? current.fredApiKey,
        fredApiKeyRaw: fredKey ?? current.fredApiKeyRaw,
        backfillYears: int(body.backfill_years, current.backfillYears, 1),
        fredPollIntervalSeconds: int(body.fred_poll_interval_seconds, current.fredPollIntervalSeconds, 600),
        twelveDataApiKey: twelveKey ?? current.twelveDataApiKey,
        twelveDataApiKeyRaw: twelveKey ?? current.twelveDataApiKeyRaw,
        cryptoEnabled: bool(body.crypto_enabled, current.cryptoEnabled),
        cryptoPollIntervalSeconds: int(body.crypto_poll_interval_seconds, current.cryptoPollIntervalSeconds, 60),
        quotesEnabled: bool(body.quotes_enabled, current.quotesEnabled),
        quotesPollIntervalSeconds: int(body.quotes_poll_interval_seconds, current.quotesPollIntervalSeconds, 600),
        calendarEnabled: bool(body.calendar_enabled, current.calendarEnabled),
        calendarPollIntervalSeconds: int(body.calendar_poll_interval_seconds, current.calendarPollIntervalSeconds, 60),
        eventWindow: {
          minImpact: parseImpact(typeof window.min_impact === "string" ? window.min_impact : undefined)
            ?? current.eventWindow.minImpact,
          beforeMinutes: int(window.before_minutes, current.eventWindow.beforeMinutes, 0),
          afterMinutes: int(window.after_minutes, current.eventWindow.afterMinutes, 0),
          blockTrades: bool(window.block_trades, current.eventWindow.blockTrades),
        },
      };

      await updateMacroConfigInWatchlist(watchlistPath, merged);
      return c.json({ state: await reloadAndState(runtime, watchlistPath) });
    } catch (error) {
      return c.json({ detail: error instanceof Error ? error.message : String(error) }, 400);
    }
  });

  return app;
}
