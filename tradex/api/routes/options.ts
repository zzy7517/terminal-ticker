/**
 * Options & GEX Analysis - API Routes
 *
 * Endpoints:
 *   GET /api/options/gex/current?symbol=SPY    — Current GEX snapshot
 *   GET /api/options/gex/strikes?symbol=SPY    — Per-strike GEX breakdown
 *   GET /api/options/levels?symbol=SPY         — Key levels (ZGL, Walls)
 *   GET /api/options/unusual?symbol=SPY        — Unusual activity
 *   GET /api/options/history?symbol=SPY&limit= — Historical GEX
 *   POST /api/options/refresh?symbol=SPY       — Force refresh
 */

import { Hono } from "hono";
import type { AppRuntime } from "../runtime.js";

export function optionsRoutes(runtime: AppRuntime): Hono {
  const app = new Hono();

  // GET /api/options/gex/current
  app.get("/api/options/gex/current", (c) => {
    const svc = runtime.optionsService;
    if (!svc) return c.json({ error: "Options service not enabled" }, 503);

    const symbol = (c.req.query("symbol") ?? "SPY").toUpperCase();
    const snapshot = svc.getSnapshot(symbol);

    if (!snapshot) {
      return c.json({ error: `No GEX data available for ${symbol}` }, 404);
    }

    return c.json(snapshot);
  });

  // GET /api/options/gex/strikes
  app.get("/api/options/gex/strikes", (c) => {
    const svc = runtime.optionsService;
    if (!svc) return c.json({ error: "Options service not enabled" }, 503);

    const symbol = (c.req.query("symbol") ?? "SPY").toUpperCase();
    const snapshot = svc.getSnapshot(symbol);

    if (!snapshot) {
      return c.json({ error: `No GEX data for ${symbol}` }, 404);
    }

    return c.json({
      symbol,
      spotPrice: snapshot.spotPrice,
      zeroGammaLevel: snapshot.zeroGammaLevel,
      strikes: snapshot.gexByStrike,
    });
  });

  // GET /api/options/levels
  app.get("/api/options/levels", (c) => {
    const svc = runtime.optionsService;
    if (!svc) return c.json({ error: "Options service not enabled" }, 503);

    const symbol = (c.req.query("symbol") ?? "SPY").toUpperCase();
    const snapshot = svc.getSnapshot(symbol);

    if (!snapshot) {
      return c.json({ error: `No data for ${symbol}` }, 404);
    }

    return c.json({
      symbol,
      spotPrice: snapshot.spotPrice,
      zeroGammaLevel: snapshot.keyLevels.zeroGammaLevel,
      callWall: snapshot.keyLevels.callWall,
      putWall: snapshot.keyLevels.putWall,
      maxGammaStrike: snapshot.keyLevels.maxGammaStrike,
      regime: snapshot.regime,
      regimeDescription: snapshot.regimeDescription,
      netGexBillions: snapshot.netGexBillions,
      charmFlow: snapshot.charmVanna?.charmFlow ?? null,
      vannaFlow: snapshot.charmVanna?.vannaFlow ?? null,
    });
  });

  // GET /api/options/unusual
  app.get("/api/options/unusual", (c) => {
    const svc = runtime.optionsService;
    if (!svc) return c.json({ error: "Options service not enabled" }, 503);

    const symbol = c.req.query("symbol")?.toUpperCase() ?? undefined;
    const limit = parseInt(c.req.query("limit") ?? "50", 10);

    const items = svc.getUnusualActivity(symbol, limit);
    return c.json({ items });
  });

  // GET /api/options/history
  app.get("/api/options/history", (c) => {
    const svc = runtime.optionsService;
    if (!svc) return c.json({ error: "Options service not enabled" }, 503);

    const symbol = (c.req.query("symbol") ?? "SPY").toUpperCase();
    const limit = parseInt(c.req.query("limit") ?? "100", 10);

    const data = svc.getHistory(symbol, limit);
    return c.json({ symbol, data, count: data.length });
  });

  // POST /api/options/refresh
  app.post("/api/options/refresh", async (c) => {
    const svc = runtime.optionsService;
    if (!svc) return c.json({ error: "Options service not enabled" }, 503);

    const symbol = (c.req.query("symbol") ?? "SPY").toUpperCase();

    try {
      const snapshot = await svc.refresh(symbol);
      if (!snapshot) {
        return c.json({ error: `Failed to refresh ${symbol}` }, 500);
      }
      return c.json(snapshot);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return c.json({ error: msg }, 500);
    }
  });

  return app;
}
