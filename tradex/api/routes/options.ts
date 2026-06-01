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
 *   POST /api/options/config                   — Update options config
 */

import { Hono } from "hono";
import { updateOptionsConfigInWatchlist } from "../../config/watchlist_store.js";
import type { OptionsConfig } from "../../options/domain.js";
import type { AppRuntime } from "../runtime.js";
import { requireConfigPath, reloadAndState } from "../helpers.js";

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

  // POST /api/options/config — update options configuration
  app.post("/api/options/config", async (c) => {
    try {
      const body = (await c.req.json()) as Record<string, unknown>;
      const watchlistPath = requireConfigPath(runtime);
      const current = runtime.config.options;

      const merged: OptionsConfig = {
        enabled: typeof body.enabled === "boolean" ? body.enabled : current.enabled,
        provider: (["yfinance", "tradier", "deribit"] as const).includes(body.provider as any)
          ? (body.provider as OptionsConfig["provider"])
          : current.provider,
        symbols: Array.isArray(body.symbols)
          ? body.symbols.map(String).filter(Boolean).map((s: string) => s.toUpperCase())
          : current.symbols,
        pollIntervalSeconds: typeof body.pollIntervalSeconds === "number" ? body.pollIntervalSeconds : current.pollIntervalSeconds,
        strikeRangePercent: typeof body.strikeRangePercent === "number" ? body.strikeRangePercent : current.strikeRangePercent,
        riskFreeRate: current.riskFreeRate,
        dividendYield: current.dividendYield,
        tradier: body.tradier && typeof body.tradier === "object" ? {
          apiKey: typeof (body.tradier as any).apiKey === "string" ? (body.tradier as any).apiKey : (current.tradier?.apiKey ?? ""),
          baseUrl: typeof (body.tradier as any).baseUrl === "string" ? (body.tradier as any).baseUrl : (current.tradier?.baseUrl ?? "https://sandbox.tradier.com/v1"),
        } : current.tradier,
        deribit: body.deribit && typeof body.deribit === "object" ? {
          enabled: typeof (body.deribit as any).enabled === "boolean" ? (body.deribit as any).enabled : (current.deribit?.enabled ?? false),
          currencies: Array.isArray((body.deribit as any).currencies) ? (body.deribit as any).currencies : (current.deribit?.currencies ?? ["BTC", "ETH"]),
        } : current.deribit,
        alerts: current.alerts,
      };

      await updateOptionsConfigInWatchlist(watchlistPath, merged);
      return c.json({ state: await reloadAndState(runtime, watchlistPath) });
    } catch (error) {
      return c.json({ detail: error instanceof Error ? error.message : String(error) }, 400);
    }
  });

  return app;
}
