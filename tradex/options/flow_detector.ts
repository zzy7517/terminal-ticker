/**
 * Flow Detector
 *
 * - Multi-leg structure detection (spreads, straddles, strangles, etc.)
 * - Whale trade tracking with composite scoring
 * - Flow Toxicity Score (delta-weighted directional bias)
 *
 * Reference: laloquidity/btc-options-flow
 */

import type { OptionQuote } from "./domain.js";

// ============================================================================
// Types
// ============================================================================

export type LegStructure =
  | "vertical-spread"
  | "straddle"
  | "strangle"
  | "risk-reversal"
  | "calendar-spread"
  | "single";

export interface TradeFlow {
  symbol: string;
  strike: number;
  type: "call" | "put";
  expiration: string;
  direction: "buy" | "sell";
  size: number;           // contracts
  premium: number;        // total $ premium
  iv: number | null;
  timestampMs: number;
  spotPrice: number;
}

export interface MultiLegGroup {
  structure: LegStructure;
  legs: TradeFlow[];
  netPremium: number;
  sentiment: "bullish" | "bearish" | "neutral" | "vol_trade";
  description: string;
  timestampMs: number;
}

export interface WhaleAlert {
  trade: TradeFlow | MultiLegGroup;
  notional: number;       // $ notional value
  tier: "massive" | "major" | "whale" | "notable";
  compositeScore: number; // Weighted score for sorting
  timestampMs: number;
}

export interface FlowToxicity {
  /** -1.0 (extremely bullish) to +1.0 (extremely bearish) */
  score: number;
  /** Total buy-side delta-weighted volume */
  buyPressure: number;
  /** Total sell-side delta-weighted volume */
  sellPressure: number;
  /** Interpretation */
  label: "strong-bullish" | "bullish" | "neutral" | "bearish" | "strong-bearish";
}

// ============================================================================
// Multi-Leg Structure Detection
// ============================================================================

/**
 * Group trades within ±2 seconds and ±20% size into multi-leg structures.
 */
export function detectMultiLegStructures(
  trades: TradeFlow[],
  timeWindowMs = 2000,
  sizeTolerancePct = 0.20,
): MultiLegGroup[] {
  if (trades.length === 0) return [];

  const sorted = [...trades].sort((a, b) => a.timestampMs - b.timestampMs);
  const used = new Set<number>();
  const groups: MultiLegGroup[] = [];

  for (let i = 0; i < sorted.length; i++) {
    if (used.has(i)) continue;

    const candidates: number[] = [i];
    for (let j = i + 1; j < sorted.length; j++) {
      if (used.has(j)) continue;
      if (sorted[j].timestampMs - sorted[i].timestampMs > timeWindowMs) break;

      const sizeDiff = Math.abs(sorted[j].size - sorted[i].size) / sorted[i].size;
      if (sizeDiff <= sizeTolerancePct) {
        candidates.push(j);
      }
    }

    if (candidates.length >= 2) {
      const legs = candidates.map(idx => sorted[idx]);
      const structure = classifyStructure(legs);

      if (structure !== "single") {
        for (const idx of candidates) used.add(idx);
        const netPremium = legs.reduce((sum, l) =>
          sum + (l.direction === "buy" ? -l.premium : l.premium), 0);
        const sentiment = deriveSentiment(structure, legs);

        groups.push({
          structure,
          legs,
          netPremium,
          sentiment,
          description: describeStructure(structure, legs),
          timestampMs: legs[0].timestampMs,
        });
      }
    }
  }

  return groups;
}

function classifyStructure(legs: TradeFlow[]): LegStructure {
  if (legs.length !== 2) return "single";
  const [a, b] = legs;

  const sameExpiry = a.expiration === b.expiration;
  const sameStrike = Math.abs(a.strike - b.strike) / a.strike < 0.02;
  const sameType = a.type === b.type;
  const sameDirection = a.direction === b.direction;
  const hasPut = a.type === "put" || b.type === "put";
  const hasCall = a.type === "call" || b.type === "call";

  if (sameExpiry && hasPut && hasCall) {
    if (sameDirection && sameStrike) return "straddle";
    if (sameDirection && !sameStrike) return "strangle";
    if (!sameDirection) return "risk-reversal";
  }

  if (sameType && sameDirection && !sameExpiry) return "calendar-spread";
  if (sameType && sameExpiry && !sameDirection) return "vertical-spread";

  return "single";
}

function deriveSentiment(
  structure: LegStructure,
  legs: TradeFlow[],
): "bullish" | "bearish" | "neutral" | "vol_trade" {
  switch (structure) {
    case "straddle":
    case "strangle":
      return "vol_trade";
    case "risk-reversal": {
      const callLeg = legs.find(l => l.type === "call");
      return callLeg?.direction === "buy" ? "bullish" : "bearish";
    }
    case "vertical-spread": {
      const buyer = legs.find(l => l.direction === "buy");
      if (!buyer) return "neutral";
      return buyer.type === "call" ? "bullish" : "bearish";
    }
    case "calendar-spread":
      return "neutral";
    default:
      return "neutral";
  }
}

function describeStructure(structure: LegStructure, legs: TradeFlow[]): string {
  const [a, b] = legs;
  switch (structure) {
    case "straddle":
      return `${a.direction.toUpperCase()} Straddle @ ${a.strike} (${a.expiration})`;
    case "strangle":
      return `${a.direction.toUpperCase()} Strangle ${Math.min(a.strike, b.strike)}/${Math.max(a.strike, b.strike)} (${a.expiration})`;
    case "risk-reversal":
      return `Risk Reversal ${a.strike}/${b.strike} (${a.expiration})`;
    case "vertical-spread":
      return `${a.type.toUpperCase()} Spread ${Math.min(a.strike, b.strike)}/${Math.max(a.strike, b.strike)} (${a.expiration})`;
    case "calendar-spread":
      return `Calendar ${a.strike} (${a.expiration}/${b.expiration})`;
    default:
      return "Single leg";
  }
}

// ============================================================================
// Whale Trade Tracking
// ============================================================================

export interface WhaleConfig {
  /** Minimum notional to qualify (default: $500,000) */
  minNotional?: number;
  /** Minimum contracts for crypto (default: 50) */
  minContracts?: number;
}

const WHALE_TIERS = [
  { tier: "massive" as const, threshold: 10_000_000 },
  { tier: "major" as const, threshold: 1_000_000 },
  { tier: "whale" as const, threshold: 500_000 },
  { tier: "notable" as const, threshold: 100_000 },
];

/**
 * Identify whale trades from a list of flows.
 * Applies composite weighted scoring for prioritization.
 */
export function identifyWhales(
  trades: TradeFlow[],
  spotPrice: number,
  config: WhaleConfig = {},
): WhaleAlert[] {
  const { minNotional = 500_000 } = config;
  const alerts: WhaleAlert[] = [];

  for (const trade of trades) {
    const notional = trade.premium;
    if (notional < minNotional) continue;

    const tier = WHALE_TIERS.find(t => notional >= t.threshold)?.tier ?? "notable";
    const score = computeWhaleScore(trade, spotPrice, notional);

    alerts.push({ trade, notional, tier, compositeScore: score, timestampMs: trade.timestampMs });
  }

  return alerts.sort((a, b) => b.compositeScore - a.compositeScore);
}

/**
 * Composite weighted sort score.
 * Factors: notional (40%), DTE urgency (25%), spot proximity (15%),
 * adversity (10%), recency (10%)
 */
function computeWhaleScore(
  trade: TradeFlow,
  spotPrice: number,
  notional: number,
): number {
  // 1. Notional (40%) — log scale
  const notionalScore = Math.log10(Math.max(notional, 1)) / 8; // normalized ~0-1

  // 2. DTE urgency (25%) — exponential decay, 7-day half-life
  const expDate = new Date(trade.expiration + "T16:00:00-04:00");
  const dte = Math.max(0, (expDate.getTime() - trade.timestampMs) / (24 * 3600 * 1000));
  const dteScore = Math.exp(-dte * Math.LN2 / 7); // half-life 7 days

  // 3. Spot proximity (15%) — ATM > NTM > OTM
  const moneyness = Math.abs(trade.strike - spotPrice) / spotPrice;
  const proximityScore = Math.exp(-moneyness * 20); // fast decay away from ATM

  // 4. Recency (10%) — 48h half-life
  const ageHours = (Date.now() - trade.timestampMs) / 3600_000;
  const recencyScore = Math.exp(-ageHours * Math.LN2 / 48);

  // 5. Placeholder adversity (10%) — would need position context
  const adversityScore = 0.5;

  return (
    notionalScore * 0.40 +
    dteScore * 0.25 +
    proximityScore * 0.15 +
    adversityScore * 0.10 +
    recencyScore * 0.10
  );
}

// ============================================================================
// Flow Toxicity Score
// ============================================================================

/**
 * Compute a single Flow Toxicity Score from recent trade flows.
 * -1.0 = extremely bullish, +1.0 = extremely bearish.
 *
 * Uses delta-weighted P/C ratio:
 * ATM trades weighted 1.0x, Deep OTM weighted 0.1x
 */
export function computeFlowToxicity(
  trades: TradeFlow[],
  spotPrice: number,
): FlowToxicity {
  let buyPressure = 0;
  let sellPressure = 0;

  for (const trade of trades) {
    // Delta weight: ATM=1.0, deep OTM=0.1
    const moneyness = Math.abs(trade.strike - spotPrice) / spotPrice;
    const deltaWeight = Math.max(0.1, 1.0 - moneyness * 5);

    const weightedSize = trade.size * deltaWeight;

    // Calls bought = bullish, puts bought = bearish
    const isBullish = (trade.type === "call" && trade.direction === "buy") ||
                      (trade.type === "put" && trade.direction === "sell");

    if (isBullish) {
      buyPressure += weightedSize;
    } else {
      sellPressure += weightedSize;
    }
  }

  const total = buyPressure + sellPressure;
  if (total === 0) {
    return { score: 0, buyPressure: 0, sellPressure: 0, label: "neutral" };
  }

  // Score: -1 (all buy) to +1 (all sell)
  const score = (sellPressure - buyPressure) / total;

  let label: FlowToxicity["label"];
  if (score <= -0.5) label = "strong-bullish";
  else if (score <= -0.15) label = "bullish";
  else if (score >= 0.5) label = "strong-bearish";
  else if (score >= 0.15) label = "bearish";
  else label = "neutral";

  return { score, buyPressure, sellPressure, label };
}
