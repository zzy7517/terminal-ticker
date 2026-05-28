/**
 * Regime Detector — pure data computation, no LLM calls.
 *
 * Reads from DataFeedRegistry + candle data to produce a RegimeSignal.
 * Designed to run in <100ms at $0 cost.
 */

import type { RegimeSignal, MarketRegime, VolatilityRegime, TrendRegime, RegimeIndicators } from "./types.js";
import type { DataFeedRegistry } from "../data_feeds/registry.js";
import type { FearGreedData, FundingSnapshot, LongShortRatioData, OIDeltaData, DXYData } from "../data_feeds/types.js";

export interface RegimeDetectorDeps {
  dataFeeds: DataFeedRegistry;
  /** Get current VIX price from quote state (TickerController). */
  getVIX: () => number | null;
  /** Get ADX(14) for the target instrument from candle cache. */
  getADX: (instrumentKey: string) => number | null;
  /** Get the primary instrument's funding rate. */
  getPrimaryFunding: (instrumentKey: string) => number | null;
}

export class RegimeDetector {
  private deps: RegimeDetectorDeps;

  constructor(deps: RegimeDetectorDeps) {
    this.deps = deps;
  }

  detect(instrumentKey: string): RegimeSignal {
    const vix = this.deps.getVIX();
    const adx = this.deps.getADX(instrumentKey);
    const fearGreed = this.deps.dataFeeds.get<FearGreedData>("fear_greed")?.getLatest();
    const funding = this.deps.dataFeeds.get<FundingSnapshot>("funding")?.getLatest();
    const ls = this.deps.dataFeeds.get<LongShortRatioData>("long_short_ratio")?.getLatest();
    const oi = this.deps.dataFeeds.get<OIDeltaData>("oi_delta")?.getLatest();
    const dxy = this.deps.dataFeeds.get<DXYData>("dxy")?.getLatest();

    const indicators: RegimeIndicators = {
      vix,
      adx,
      fearGreed: fearGreed?.value ?? null,
      fundingRate: funding?.rate ?? this.deps.getPrimaryFunding(instrumentKey),
      longShortRatio: ls?.ratio ?? null,
      oiDelta1h: oi?.delta1h ?? null,
      dxy: dxy?.value ?? null,
    };

    return {
      market: this.detectMarketRegime(indicators),
      volatility: this.detectVolatility(indicators),
      trend: this.detectTrend(indicators),
      indicators,
      detectedAt: new Date().toISOString(),
    };
  }

  private detectMarketRegime(ind: RegimeIndicators): MarketRegime {
    let score = 0; // positive = risk on, negative = risk off

    // VIX
    if (ind.vix !== null) {
      if (ind.vix < 16) score += 2;
      else if (ind.vix < 20) score += 1;
      else if (ind.vix > 30) score -= 2;
      else if (ind.vix > 25) score -= 1;
    }

    // Fear & Greed
    if (ind.fearGreed !== null) {
      if (ind.fearGreed > 70) score += 1;
      else if (ind.fearGreed > 55) score += 0.5;
      else if (ind.fearGreed < 25) score -= 1;
      else if (ind.fearGreed < 40) score -= 0.5;
    }

    // Funding rate (extreme = crowded)
    if (ind.fundingRate !== null) {
      if (ind.fundingRate > 0.001) score += 0.5;  // bullish crowd
      else if (ind.fundingRate < -0.001) score -= 0.5;
    }

    // OI growth = money flowing in = bullish
    if (ind.oiDelta1h !== null) {
      if (ind.oiDelta1h > 0) score += 0.5;
      else if (ind.oiDelta1h < 0) score -= 0.5;
    }

    if (score >= 2) return "RISK_ON";
    if (score <= -2) return "RISK_OFF";
    return "NEUTRAL";
  }

  private detectVolatility(ind: RegimeIndicators): VolatilityRegime {
    const vix = ind.vix;
    if (vix === null) return "MEDIUM";
    if (vix >= 35) return "EXTREME";
    if (vix >= 25) return "HIGH";
    if (vix >= 16) return "MEDIUM";
    return "LOW";
  }

  private detectTrend(ind: RegimeIndicators): TrendRegime {
    const adx = ind.adx;
    if (adx === null) return "RANGE";

    // ADX only tells strength, not direction. We combine with Fear/Greed as proxy.
    const fg = ind.fearGreed ?? 50;
    const bullish = fg > 50;

    if (adx >= 40) return bullish ? "STRONG_UP" : "STRONG_DOWN";
    if (adx >= 25) return bullish ? "UP" : "DOWN";
    return "RANGE";
  }
}
