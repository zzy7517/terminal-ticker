/**
 * Options & GEX Analysis - API Routes
 *
 * Endpoints:
 *   GET /api/options/gex/current?symbol=SPY    — Current GEX snapshot
 *   GET /api/options/gex/strikes?symbol=SPY    — Per-strike GEX breakdown
 *   GET /api/options/levels?symbol=SPY         — Key levels (ZGL, Walls)
 *   GET /api/options/unusual?symbol=SPY        — Unusual activity
 *   GET /api/options/history?symbol=SPY&limit= — Historical GEX
 *   GET /api/options/iv-surface?symbol=SPY     — IV surface + regime params
 *   GET /api/options/impulse?symbol=SPY        — Hedge impulse curve
 *   GET /api/options/pressure?symbol=SPY       — Pressure cloud (zones/edges)
 *   GET /api/options/exposure?symbol=SPY       — Full 4D exposure breakdown
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

  // GET /api/options/iv-surface
  app.get("/api/options/iv-surface", (c) => {
    const svc = runtime.optionsService;
    if (!svc) return c.json({ error: "Options service not enabled" }, 503);

    const symbol = (c.req.query("symbol") ?? "SPY").toUpperCase();
    const snapshot = svc.getSnapshot(symbol);
    if (!snapshot) return c.json({ error: `No data for ${symbol}` }, 404);

    return c.json({
      symbol,
      spotPrice: snapshot.spotPrice,
      ivSurface: snapshot.ivSurface,
      regimeParams: snapshot.regimeParams,
    });
  });

  // GET /api/options/impulse
  app.get("/api/options/impulse", (c) => {
    const svc = runtime.optionsService;
    if (!svc) return c.json({ error: "Options service not enabled" }, 503);

    const symbol = (c.req.query("symbol") ?? "SPY").toUpperCase();
    const snapshot = svc.getSnapshot(symbol);
    if (!snapshot) return c.json({ error: `No data for ${symbol}` }, 404);
    if (!snapshot.hedgeImpulse) return c.json({ error: `No hedge impulse data for ${symbol}` }, 404);

    return c.json({
      symbol,
      spotPrice: snapshot.spotPrice,
      hedgeImpulse: snapshot.hedgeImpulse,
    });
  });

  // GET /api/options/pressure
  app.get("/api/options/pressure", (c) => {
    const svc = runtime.optionsService;
    if (!svc) return c.json({ error: "Options service not enabled" }, 503);

    const symbol = (c.req.query("symbol") ?? "SPY").toUpperCase();
    const snapshot = svc.getSnapshot(symbol);
    if (!snapshot) return c.json({ error: `No data for ${symbol}` }, 404);
    if (!snapshot.pressureCloud) return c.json({ error: `No pressure cloud data for ${symbol}` }, 404);

    return c.json({
      symbol,
      spotPrice: snapshot.spotPrice,
      pressureCloud: snapshot.pressureCloud,
    });
  });

  // GET /api/options/exposure
  app.get("/api/options/exposure", (c) => {
    const svc = runtime.optionsService;
    if (!svc) return c.json({ error: "Options service not enabled" }, 503);

    const symbol = (c.req.query("symbol") ?? "SPY").toUpperCase();
    const snapshot = svc.getSnapshot(symbol);
    if (!snapshot) return c.json({ error: `No data for ${symbol}` }, 404);

    return c.json({
      symbol,
      spotPrice: snapshot.spotPrice,
      exposure: snapshot.exposure,
    });
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
        provider: (["yfinance", "tradier", "deribit", "marketdata"] as const).includes(body.provider as any)
          ? (body.provider as OptionsConfig["provider"])
          : current.provider,
        symbols: Array.isArray(body.symbols)
          ? body.symbols.map(String).filter(Boolean).map((s: string) => s.toUpperCase())
          : current.symbols,
        pollIntervalSeconds: typeof body.pollIntervalSeconds === "number" ? body.pollIntervalSeconds : current.pollIntervalSeconds,
        strikeRangePercent: typeof body.strikeRangePercent === "number" ? body.strikeRangePercent : current.strikeRangePercent,
        riskFreeRate: current.riskFreeRate,
        dividendYield: current.dividendYield,
        tradier: body.tradier && typeof body.tradier === "object" ? (() => {
          const tr = body.tradier as any;
          // A new key replaces both the resolved value and the raw form; the
          // watchlist store interns literals into the secrets vault on save.
          const hasNewKey = typeof tr.apiKey === "string" && tr.apiKey.length > 0;
          return {
            apiKey: hasNewKey ? tr.apiKey : (current.tradier?.apiKey ?? ""),
            apiKeyRaw: hasNewKey ? tr.apiKey : current.tradier?.apiKeyRaw,
            baseUrl: typeof tr.baseUrl === "string" ? tr.baseUrl : (current.tradier?.baseUrl ?? "https://sandbox.tradier.com/v1"),
          };
        })() : current.tradier,
        marketdata: body.marketdata && typeof body.marketdata === "object"
          ? (() => {
              const md = body.marketdata as any;
              // A new apiKey string from the UI becomes both the resolved key and
              // the raw TOML value. Absent => keep existing (raw env-ref preserved).
              const hasNewKey = typeof md.apiKey === "string" && md.apiKey.length > 0;
              // null clears an override (back to default); undefined keeps current.
              const pickNum = (v: unknown, cur: number | undefined): number | undefined => {
                if (v === null) return undefined;
                if (typeof v === "number" && Number.isFinite(v)) return v;
                return cur;
              };
              return {
                apiKey: hasNewKey ? md.apiKey : (current.marketdata?.apiKey ?? ""),
                apiKeyRaw: hasNewKey ? md.apiKey : current.marketdata?.apiKeyRaw,
                baseUrl: typeof md.baseUrl === "string" ? md.baseUrl : (current.marketdata?.baseUrl ?? "https://api.marketdata.app/v1"),
                strikeLimit: pickNum(md.strikeLimit, current.marketdata?.strikeLimit),
                dte: pickNum(md.dte, current.marketdata?.dte),
                callsPerMinute: pickNum(md.callsPerMinute, current.marketdata?.callsPerMinute),
              };
            })()
          : current.marketdata,
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
