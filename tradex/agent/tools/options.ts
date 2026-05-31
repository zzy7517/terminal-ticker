/**
 * Agent Tools - Options & GEX Analysis
 *
 * Tools for the AI agent to query gamma exposure, dealer positioning,
 * key levels, and unusual options activity.
 */

import { ToolRegistry } from "./registry.js";
import type { AppRuntime } from "../../api/runtime.js";

/** Build a ToolRegistry containing options/GEX analysis tools. */
export function buildOptionsTools(runtime: AppRuntime): ToolRegistry {
  const registry = new ToolRegistry();
  registerOptionsTools(registry, runtime);
  return registry;
}

export function registerOptionsTools(registry: ToolRegistry, runtime: AppRuntime): void {
  const svc = runtime.optionsService;

  registry.register({
    name: "get_gex_snapshot",
    description: "Get current Gamma Exposure (GEX) analysis for a symbol. Returns net GEX, regime (long/short gamma), zero gamma level, call/put walls, and charm/vanna hidden flows. Use to understand dealer positioning and predict volatility behavior.",
    parameters: {
      type: "object",
      properties: {
        symbol: {
          type: "string",
          description: "Symbol to analyze (e.g., SPY, QQQ, AAPL, NVDA, GLD, IBIT, BTC, ETH). Default: SPY",
        },
      },
    },
    execute: async (args: Record<string, unknown>) => {
      if (!svc) return JSON.stringify({ error: "Options service not enabled. Set [options] enabled = true in config." });

      const symbol = (typeof args.symbol === "string" ? args.symbol : "SPY").toUpperCase();
      const snapshot = svc.getSnapshot(symbol);

      if (!snapshot) {
        return JSON.stringify({ error: `No GEX data available for ${symbol}. It may not be in the configured symbols list or data hasn't been fetched yet.` });
      }

      return JSON.stringify({
        symbol: snapshot.symbol,
        spotPrice: snapshot.spotPrice,
        netGexBillions: Math.round(snapshot.netGexBillions * 100) / 100,
        regime: snapshot.regime,
        regimeDescription: snapshot.regimeDescription,
        zeroGammaLevel: Math.round(snapshot.zeroGammaLevel * 100) / 100,
        zglDistancePercent: Math.round((snapshot.zeroGammaLevel - snapshot.spotPrice) / snapshot.spotPrice * 10000) / 100,
        callWall: snapshot.keyLevels.callWall,
        putWall: snapshot.keyLevels.putWall,
        maxGammaStrike: snapshot.keyLevels.maxGammaStrike,
        charmFlow: snapshot.charmVanna ? Math.round(snapshot.charmVanna.charmFlow) : null,
        vannaFlow: snapshot.charmVanna ? Math.round(snapshot.charmVanna.vannaFlow) : null,
        netHiddenFlow: snapshot.charmVanna ? Math.round(snapshot.charmVanna.netHiddenFlow) : null,
        totalCallGexBillions: Math.round(snapshot.totalCallGex / 1e9 * 100) / 100,
        totalPutGexBillions: Math.round(snapshot.totalPutGex / 1e9 * 100) / 100,
        provider: snapshot.provider,
        timestamp: new Date(snapshot.timestamp).toISOString(),
      });
    },
  });

  registry.register({
    name: "get_dealer_levels",
    description: "Get key dealer positioning levels: Call Wall (resistance), Put Wall (support), Zero Gamma Level (regime transition), and Max Gamma Strike. Quick summary for trade planning.",
    parameters: {
      type: "object",
      properties: {
        symbol: { type: "string", description: "Symbol (default: SPY)" },
      },
    },
    execute: async (args: Record<string, unknown>) => {
      if (!svc) return JSON.stringify({ error: "Options service not enabled." });

      const symbol = (typeof args.symbol === "string" ? args.symbol : "SPY").toUpperCase();
      const snapshot = svc.getSnapshot(symbol);
      if (!snapshot) return JSON.stringify({ error: `No data for ${symbol}` });

      const spot = snapshot.spotPrice;
      return JSON.stringify({
        symbol,
        spotPrice: spot,
        zeroGammaLevel: snapshot.keyLevels.zeroGammaLevel,
        zglDistance: `${((snapshot.keyLevels.zeroGammaLevel - spot) / spot * 100).toFixed(2)}%`,
        callWall: snapshot.keyLevels.callWall,
        callWallDistance: `+${((snapshot.keyLevels.callWall - spot) / spot * 100).toFixed(2)}%`,
        putWall: snapshot.keyLevels.putWall,
        putWallDistance: `${((snapshot.keyLevels.putWall - spot) / spot * 100).toFixed(2)}%`,
        maxGammaStrike: snapshot.keyLevels.maxGammaStrike,
        regime: snapshot.regime,
        netGexBillions: Math.round(snapshot.netGexBillions * 100) / 100,
      });
    },
  });

  registry.register({
    name: "get_options_flow",
    description: "Get unusual options activity — large OI changes, high volume/OI ratio trades, or big premium prints. Shows what institutional players are doing RIGHT NOW.",
    parameters: {
      type: "object",
      properties: {
        symbol: { type: "string", description: "Filter by symbol (optional, shows all if omitted)" },
        limit: { type: "number", description: "Max results (default: 20)" },
      },
    },
    execute: async (args: Record<string, unknown>) => {
      if (!svc) return JSON.stringify({ error: "Options service not enabled." });

      const symbol = typeof args.symbol === "string" ? args.symbol.toUpperCase() : undefined;
      const limit = typeof args.limit === "number" ? args.limit : 20;
      const items = svc.getUnusualActivity(symbol, limit);

      if (items.length === 0) {
        return JSON.stringify({ message: "No unusual activity detected recently." });
      }

      return JSON.stringify({
        count: items.length,
        items: items.map(item => ({
          symbol: item.symbol,
          strike: item.strike,
          type: item.type,
          expiration: item.expiration,
          oiChange: item.oiChange,
          volume: item.volume,
          volumeOiRatio: Math.round(item.volumeOiRatio * 10) / 10,
          premiumEstimate: `$${Math.round(item.premiumEstimate).toLocaleString()}`,
          signal: item.signal,
          time: new Date(item.timestampMs).toISOString(),
        })),
      });
    },
  });

  registry.register({
    name: "get_gamma_regime",
    description: "Determine if market is in positive gamma (volatility-suppressing) or negative gamma (volatility-amplifying) regime. Includes implication for trading.",
    parameters: {
      type: "object",
      properties: {
        symbol: { type: "string", description: "Symbol (default: SPY)" },
      },
    },
    execute: async (args: Record<string, unknown>) => {
      if (!svc) return JSON.stringify({ error: "Options service not enabled." });

      const symbol = (typeof args.symbol === "string" ? args.symbol : "SPY").toUpperCase();
      const snapshot = svc.getSnapshot(symbol);
      if (!snapshot) return JSON.stringify({ error: `No data for ${symbol}` });

      const implications: Record<string, string> = {
        long_gamma: "Dealers will sell rallies and buy dips → mean-reversion favored, breakouts likely to fail. Range-bound strategies (selling premium, fading extremes) tend to work.",
        short_gamma: "Dealers will buy rallies and sell dips → trends accelerate, volatility expands. Directional/momentum strategies tend to work. Stop losses more likely to get swept.",
        neutral: "No strong dealer bias. Market driven by flow rather than mechanical hedging.",
      };

      return JSON.stringify({
        symbol,
        regime: snapshot.regime,
        description: snapshot.regimeDescription,
        implication: implications[snapshot.regime],
        netGexBillions: Math.round(snapshot.netGexBillions * 100) / 100,
        zglDistance: `${((snapshot.zeroGammaLevel - snapshot.spotPrice) / snapshot.spotPrice * 100).toFixed(2)}%`,
        spotPrice: snapshot.spotPrice,
        zeroGammaLevel: snapshot.keyLevels.zeroGammaLevel,
      });
    },
  });
}
