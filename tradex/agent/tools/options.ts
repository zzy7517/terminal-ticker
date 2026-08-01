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
        regimeParams: snapshot.regimeParams
          ? {
              atmIV: Math.round(snapshot.regimeParams.atmIV * 1000) / 10 + "%",
              volRegime: snapshot.regimeParams.regime,
              impliedSpotVolCorr: Math.round(snapshot.regimeParams.impliedSpotVolCorr * 100) / 100,
              impliedVolOfVol: Math.round(snapshot.regimeParams.impliedVolOfVol * 100) / 100,
              expectedDailySpotMove: Math.round(snapshot.regimeParams.expectedDailySpotMove * 10000) / 100 + "%",
            }
          : null,
        provider: snapshot.provider,
        timestamp: new Date(snapshot.timestamp).toISOString(),
      });
    },
  });

  registry.register({
    name: "get_gex_by_strike",
    description: "Get the full per-strike Gamma Exposure (GEX) breakdown — every strike's call GEX, put GEX, net GEX, call OI, and put OI. Use to see the exact distribution of dealer gamma across strikes, identify OI concentration, validate whether walls are sharp (single spike) or broad (cluster), and detect asymmetries near spot.",
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

      const strikes = snapshot.gexByStrike;
      if (!strikes || strikes.length === 0) {
        return JSON.stringify({ error: `No per-strike GEX data for ${symbol}` });
      }

      return JSON.stringify({
        symbol,
        spotPrice: snapshot.spotPrice,
        zeroGammaLevel: snapshot.zeroGammaLevel,
        totalStrikes: strikes.length,
        strikes: strikes.map((s) => ({
          strike: s.strike,
          callGex: Math.round(s.callGex),
          putGex: Math.round(s.putGex),
          netGex: Math.round(s.netGex),
          callOi: s.callOi,
          putOi: s.putOi,
        })),
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

  registry.register({
    name: "get_hedge_impulse",
    description: "Get the dealer hedge impulse curve — where price is mechanically pinned (positive impulse / attractor) vs. where it can accelerate (negative impulse / breakout). Returns impulse regime, nearest attractor levels above/below spot, directional asymmetry, and impulse at spot. Use to predict whether price will mean-revert or trend, and identify magnet/repellent prices.",
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
      const hi = snapshot.hedgeImpulse;
      if (!hi) return JSON.stringify({ error: `No hedge impulse data for ${symbol} (insufficient IV/strikes).` });

      const regimeImplications: Record<string, string> = {
        pinned: "Strong positive impulse at spot — price is mechanically locked near current level. Favor premium selling / range strategies.",
        expansion: "Negative impulse at spot — dealers amplify moves, breakout potential. Favor directional / momentum strategies.",
        "squeeze-up": "Negative impulse above, positive below — upside squeeze setup. Bias long into the attractor above.",
        "squeeze-down": "Negative impulse below, positive above — downside squeeze setup. Bias short into the attractor below.",
        neutral: "Mixed/weak impulse signals — no strong mechanical bias.",
      };

      return JSON.stringify({
        symbol,
        spotPrice: snapshot.spotPrice,
        regime: hi.regime,
        implication: regimeImplications[hi.regime] ?? null,
        impulseAtSpot: Math.round(hi.impulseAtSpot),
        slopeAtSpot: hi.slopeAtSpot,
        nearestAttractorAbove: hi.nearestAttractorAbove,
        nearestAttractorBelow: hi.nearestAttractorBelow,
        directionalBias: hi.asymmetry.bias,
        asymmetryRatio: Math.round(hi.asymmetry.asymmetryRatio * 100) / 100,
        zeroCrossings: hi.zeroCrossings.map((z) => ({ price: Math.round(z.price * 100) / 100, direction: z.direction })),
      });
    },
  });

  registry.register({
    name: "get_pressure_cloud",
    description: "Get the options pressure cloud — reachable price zones classified as stability zones (mean-reversion, dealers hedge passively) or acceleration zones (trend-amplification, dealers hedge aggressively), plus regime-edge prices where behavior flips. Each zone carries a favored trade type (long/short) and strength. Use for concrete support/resistance and trade location.",
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
      const pc = snapshot.pressureCloud;
      if (!pc) return JSON.stringify({ error: `No pressure cloud data for ${symbol}.` });

      const fmtZone = (z: typeof pc.stabilityZones[number]) => ({
        center: Math.round(z.center * 100) / 100,
        range: [Math.round(z.lower * 100) / 100, Math.round(z.upper * 100) / 100],
        side: z.side,
        strength: Math.round(z.strength * 100) / 100,
        tradeType: z.tradeType,
        hedgeType: z.hedgeType,
      });

      return JSON.stringify({
        symbol,
        spotPrice: snapshot.spotPrice,
        stabilityZones: pc.stabilityZones.map(fmtZone),
        accelerationZones: pc.accelerationZones.map(fmtZone),
        regimeEdges: pc.regimeEdges.map((e) => ({ price: Math.round(e.price * 100) / 100, transition: e.transitionType })),
      });
    },
  });

  registry.register({
    name: "get_exposure_breakdown",
    description: "Get full 4D dealer exposure (GEX/DEX/VEX/CHEX) broken down per expiration: Gamma ($/1% move), Delta (net directional $), Vanna ($/1 vol-point), and Charm ($/1 day decay). Use to see which expirations dominate dealer hedging and how vol/time exposure is distributed.",
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
      const exp = snapshot.exposure;
      if (!exp || exp.length === 0) return JSON.stringify({ error: `No exposure data for ${symbol}.` });

      return JSON.stringify({
        symbol,
        spotPrice: snapshot.spotPrice,
        regime: snapshot.regimeParams?.regime ?? null,
        atmIV: snapshot.regimeParams ? Math.round(snapshot.regimeParams.atmIV * 1000) / 10 + "%" : null,
        perExpiry: exp.slice(0, 8).map((e) => ({
          expiration: e.expiration,
          daysToExpiry: Math.round(e.tte * 365),
          gammaExposureBillions: Math.round(e.canonical.totalGammaExposure / 1e9 * 100) / 100,
          deltaExposureBillions: Math.round(e.canonical.totalDeltaExposure / 1e9 * 100) / 100,
          vannaExposureMillions: Math.round(e.canonical.totalVannaExposure / 1e6 * 100) / 100,
          charmExposureMillions: Math.round(e.canonical.totalCharmExposure / 1e6 * 100) / 100,
        })),
      });
    },
  });
}
