import { Hono } from "hono";
import { loadInstrumentCatalog as loadBitgetInstrumentCatalog } from "../../market_data/bitget.js";
import { loadInstrumentCatalog as loadHyperliquidInstrumentCatalog } from "../../market_data/hyperliquid.js";
import {
  appendBitgetSymbolToWatchlist,
  appendHyperliquidSymbolToWatchlist,
  removeSymbolFromWatchlist,
  reorderSymbolsInWatchlist,
} from "../../config/watchlist-store.js";
import type { AppRuntime } from "../runtime.js";
import { catalogItem, requireConfigPath, reloadAndState } from "../helpers.js";

export function marketRoutes(runtime: AppRuntime): Hono {
  const app = new Hono();

  // Returns server health status and active instrument count.
  app.get("/api/health", (c) =>
    c.json({
      ok: true,
      backend: "typescript",
      symbols: runtime.instruments.length,
    }),
  );

  // Serializes the full in-memory market snapshot for the frontend.
  app.get("/api/state", async (c) => c.json(await runtime.state()));

  // Merges the Bitget and Hyperliquid instrument catalogs, falling back to
  // runtime instruments if a provider fetch fails.
  app.get("/api/instruments/catalog", async (c) => {
    const activeKeys = new Set(runtime.instruments.map((instrument) => instrument.key));
    const errors: Record<string, string> = {};
    const items: Array<Record<string, unknown>> = [];
    try {
      for (const instrument of (await loadBitgetInstrumentCatalog()).values()) {
        items.push(catalogItem(instrument, activeKeys));
      }
    } catch (error) {
      errors.bitget = error instanceof Error ? error.message : String(error);
      for (const instrument of runtime.instruments.filter((instrument) => instrument.source === "bitget")) {
        items.push(catalogItem(instrument, activeKeys));
      }
    }
    try {
      for (const instrument of (await loadHyperliquidInstrumentCatalog()).values()) {
        items.push(catalogItem(instrument, activeKeys));
      }
    } catch (error) {
      errors.hyperliquid = error instanceof Error ? error.message : String(error);
      for (const instrument of runtime.instruments.filter((instrument) => instrument.source === "hyperliquid")) {
        items.push(catalogItem(instrument, activeKeys));
      }
    }
    return c.json({
      loadedAt: new Date().toISOString(),
      errors,
      items,
    });
  });

  // Appends a Bitget instrument to the watchlist TOML and reloads config.
  app.post("/api/watchlist/bitget", async (c) => {
    const body = (await c.req.json()) as Record<string, unknown>;
    const watchlistPath = requireConfigPath(runtime);
    await appendBitgetSymbolToWatchlist(watchlistPath, {
      symbol: String(body.symbol || ""),
      instType: String(body.instType || body.inst_type || ""),
      label: typeof body.label === "string" ? body.label : null,
      group: typeof body.group === "string" ? body.group : "crypto",
      showCollapsed: typeof body.showCollapsed === "boolean" ? body.showCollapsed : true,
    });
    return c.json({ state: await reloadAndState(runtime, watchlistPath) });
  });

  // Appends a Hyperliquid instrument to the watchlist TOML and reloads config.
  app.post("/api/watchlist/hyperliquid", async (c) => {
    const body = (await c.req.json()) as Record<string, unknown>;
    const watchlistPath = requireConfigPath(runtime);
    await appendHyperliquidSymbolToWatchlist(watchlistPath, {
      symbol: String(body.symbol || ""),
      label: typeof body.label === "string" ? body.label : null,
      group: typeof body.group === "string" ? body.group : "crypto",
      showCollapsed: typeof body.showCollapsed === "boolean" ? body.showCollapsed : true,
    });
    return c.json({ state: await reloadAndState(runtime, watchlistPath) });
  });

  // Reorders instruments in the watchlist TOML.
  app.put("/api/watchlist/reorder", async (c) => {
    const body = (await c.req.json()) as Record<string, unknown>;
    const keys = body.keys;
    if (!Array.isArray(keys) || keys.length === 0) {
      return c.json({ detail: "keys must be a non-empty array of instrument keys" }, 400);
    }
    const watchlistPath = requireConfigPath(runtime);
    await reorderSymbolsInWatchlist(watchlistPath, keys as string[]);

    // Reorder in-memory instruments to match without restarting data connections
    const keyOrder = new Map((keys as string[]).map((k, i) => [k, i]));
    runtime.instruments.sort((a, b) => {
      const ai = keyOrder.get(a.key) ?? Infinity;
      const bi = keyOrder.get(b.key) ?? Infinity;
      return ai - bi;
    });

    return c.json({ state: await runtime.state() });
  });

  // Removes an instrument from the watchlist TOML by instrument key.
  // Unlike add (which needs feed subscription), removal only evicts the key
  // from memory and skips it in candle polling — no full reload required.
  app.delete("/api/watchlist/instruments/:key", async (c) => {
    const key = decodeURIComponent(c.req.param("key"));
    const instrument = runtime.instruments.find((item) => item.key === key);
    if (!instrument) return c.json({ detail: `instrument not found: ${key}` }, 404);
    const watchlistPath = requireConfigPath(runtime);
    await removeSymbolFromWatchlist(watchlistPath, {
      source: instrument.source,
      symbol: instrument.symbol,
      instType: "instType" in instrument ? instrument.instType : null,
    });
    runtime.removeInstrument(key);
    return c.json({ state: await runtime.state() });
  });

  return app;
}
