/**
 * Hedge Impulse Curve
 *
 * Combines Gamma and Vanna exposures into a single price-space response
 * function via the empirical spot-vol coupling relationship:
 *
 *   H(S) = GEX_smoothed(S) - (k / S) × VEX_smoothed(S)
 *
 * Where k is the spot-vol coupling coefficient derived from the IV surface.
 *
 * Key insights (from floe whitepaper):
 * - No time weighting needed: Dollar GEX/VEX already incorporate time effects
 * - Physical combination via Taylor expansion, not arbitrary weights
 * - Adaptive kernel width based on strike spacing
 *
 * H(S) > 0: Stability — dealers dampen moves (mean-reversion)
 * H(S) < 0: Acceleration — dealers amplify moves (trend-continuation)
 * H(S) = 0: Regime edge — behavior flips
 *
 * Reference: FullStackCraft/floe hedgeflow/curve.ts
 */

import type { OptionQuote } from "./domain.js";
import { gamma, vanna } from "./greeks.js";
import { MIN_IV, MAX_IV, CONTRACT_MULTIPLIER, ONE_PERCENT_MOVE } from "./domain.js";

// ============================================================================
// Types
// ============================================================================

export type ImpulseRegime =
  | "pinned"        // Strong positive impulse at spot → price is locked
  | "expansion"     // Negative impulse at spot → breakout potential
  | "squeeze-up"    // Negative above + positive below → upside squeeze
  | "squeeze-down"  // Negative below + positive above → downside squeeze
  | "neutral";      // Mixed or weak signals

export interface HedgeImpulsePoint {
  price: number;
  gamma: number;   // Smoothed gamma exposure at this price
  vanna: number;   // Smoothed vanna exposure at this price
  impulse: number; // Combined: gamma - (k/S) * vanna
}

export interface ZeroCrossing {
  price: number;
  direction: "rising" | "falling"; // rising = - → +
}

export interface ImpulseExtremum {
  price: number;
  impulse: number;
  type: "basin" | "peak"; // basin = positive max (attractor), peak = negative min (accelerator)
}

export interface DirectionalAsymmetry {
  upside: number;     // Integrated impulse above spot
  downside: number;   // Integrated impulse below spot
  bias: "up" | "down" | "neutral";
  asymmetryRatio: number;
}

export interface HedgeImpulseCurve {
  spot: number;
  computedAt: number;
  spotVolCoupling: number;  // k coefficient
  kernelWidth: number;      // Lambda in price units
  strikeSpacing: number;
  curve: HedgeImpulsePoint[];
  impulseAtSpot: number;
  slopeAtSpot: number;
  zeroCrossings: ZeroCrossing[];
  extrema: ImpulseExtremum[];
  asymmetry: DirectionalAsymmetry;
  regime: ImpulseRegime;
  nearestAttractorAbove: number | null;
  nearestAttractorBelow: number | null;
}

export interface HedgeImpulseConfig {
  /** Price grid range as ±% of spot (default: 3) */
  rangePercent?: number;
  /** Price grid step as % of spot (default: 0.1) */
  stepPercent?: number;
  /** Gaussian kernel width in strike spacings (default: 2) */
  kernelWidthStrikes?: number;
  /** Risk-free rate */
  riskFreeRate?: number;
  /** Dividend yield */
  dividendYield?: number;
}

// ============================================================================
// Main Computation
// ============================================================================

/**
 * Compute the Hedge Impulse Curve from options contracts.
 *
 * @param contracts - All valid option quotes
 * @param spotPrice - Current spot price
 * @param spotVolCoupling - k coefficient (from deriveSpotVolCoupling)
 * @param config - Optional configuration
 */
export function computeHedgeImpulseCurve(
  contracts: OptionQuote[],
  spotPrice: number,
  spotVolCoupling: number,
  config: HedgeImpulseConfig = {},
): HedgeImpulseCurve {
  const {
    rangePercent = 3,
    stepPercent = 0.1,
    kernelWidthStrikes = 2,
    riskFreeRate = 0.0363,
    dividendYield = 0.015,
  } = config;

  const now = Date.now();
  const k = spotVolCoupling;

  // Extract strike-level GEX and VEX values
  const { strikes, gexValues, vexValues } = computeStrikeExposures(
    contracts, spotPrice, riskFreeRate, dividendYield
  );

  if (strikes.length < 2) {
    return emptyImpulseCurve(spotPrice, k, now);
  }

  // Detect strike spacing and compute kernel width
  const strikeSpacing = detectStrikeSpacing(strikes);
  const lambda = kernelWidthStrikes * strikeSpacing;

  // Build price grid
  const gridMin = spotPrice * (1 - rangePercent / 100);
  const gridMax = spotPrice * (1 + rangePercent / 100);
  const gridStep = spotPrice * (stepPercent / 100);

  const curve: HedgeImpulsePoint[] = [];
  for (let price = gridMin; price <= gridMax; price += gridStep) {
    const gex = kernelSmooth(strikes, gexValues, price, lambda);
    const vex = kernelSmooth(strikes, vexValues, price, lambda);
    const impulse = gex - (k / price) * vex;
    curve.push({ price, gamma: gex, vanna: vex, impulse });
  }

  // Analysis
  const impulseAtSpot = interpolateAtPrice(curve, spotPrice);
  const slopeAtSpot = computeSlope(curve, spotPrice);
  const zeroCrossings = findZeroCrossings(curve);
  const extrema = findExtrema(curve);
  const asymmetry = computeAsymmetry(curve, spotPrice);
  const regime = classifyRegime(impulseAtSpot, asymmetry, curve);

  // Nearest attractors (positive impulse basins)
  const basinsAbove = extrema.filter(e => e.type === "basin" && e.price > spotPrice);
  const basinsBelow = extrema.filter(e => e.type === "basin" && e.price < spotPrice);
  const nearestAttractorAbove = basinsAbove.length > 0
    ? basinsAbove.reduce((a, b) => a.price < b.price ? a : b).price
    : null;
  const nearestAttractorBelow = basinsBelow.length > 0
    ? basinsBelow.reduce((a, b) => a.price > b.price ? a : b).price
    : null;

  return {
    spot: spotPrice,
    computedAt: now,
    spotVolCoupling: k,
    kernelWidth: lambda,
    strikeSpacing,
    curve,
    impulseAtSpot,
    slopeAtSpot,
    zeroCrossings,
    extrema,
    asymmetry,
    regime,
    nearestAttractorAbove,
    nearestAttractorBelow,
  };
}

// ============================================================================
// Strike-Level Exposure Calculation
// ============================================================================

function computeStrikeExposures(
  contracts: OptionQuote[],
  spot: number,
  r: number,
  q: number,
): { strikes: number[]; gexValues: number[]; vexValues: number[] } {
  const gexMap = new Map<number, number>();
  const vexMap = new Map<number, number>();

  for (const c of contracts) {
    if (c.openInterest <= 0 || !c.impliedVol) continue;
    if (c.impliedVol < MIN_IV || c.impliedVol > MAX_IV) continue;

    const T = timeToExpiry(c.expiration);
    if (T <= 0) continue;

    const g = gamma(spot, c.strike, T, r, q, c.impliedVol);
    const v = vanna(spot, c.strike, T, r, q, c.impliedVol);

    // GEX: calls positive, puts negative (trader-facing)
    const gex = c.openInterest * g * CONTRACT_MULTIPLIER * spot * spot * ONE_PERCENT_MOVE;
    const signedGex = c.type === "call" ? gex : -gex;

    // VEX: vanna exposure (same sign convention)
    const vex = c.openInterest * v * CONTRACT_MULTIPLIER * spot * ONE_PERCENT_MOVE;
    const signedVex = c.type === "call" ? -vex : vex;

    gexMap.set(c.strike, (gexMap.get(c.strike) ?? 0) + signedGex);
    vexMap.set(c.strike, (vexMap.get(c.strike) ?? 0) + signedVex);
  }

  const allStrikes = Array.from(new Set([...gexMap.keys(), ...vexMap.keys()])).sort((a, b) => a - b);
  const gexValues = allStrikes.map(k => gexMap.get(k) ?? 0);
  const vexValues = allStrikes.map(k => vexMap.get(k) ?? 0);

  return { strikes: allStrikes, gexValues, vexValues };
}

// ============================================================================
// Gaussian Kernel Smoothing
// ============================================================================

/**
 * Gaussian kernel smoothing: maps strike-space exposures to price-space.
 * weight(K, S) = exp(-((K - S) / lambda)²)
 */
function kernelSmooth(
  strikes: number[],
  values: number[],
  evalPrice: number,
  lambda: number,
): number {
  let weightedSum = 0;
  let weightSum = 0;

  for (let i = 0; i < strikes.length; i++) {
    const dist = (strikes[i] - evalPrice) / lambda;
    const weight = Math.exp(-(dist * dist));
    weightedSum += values[i] * weight;
    weightSum += weight;
  }

  return weightSum > 0 ? weightedSum / weightSum : 0;
}

// ============================================================================
// Analysis Functions
// ============================================================================

function interpolateAtPrice(curve: HedgeImpulsePoint[], price: number): number {
  if (curve.length === 0) return 0;
  if (price <= curve[0].price) return curve[0].impulse;
  if (price >= curve[curve.length - 1].price) return curve[curve.length - 1].impulse;

  for (let i = 0; i < curve.length - 1; i++) {
    if (curve[i].price <= price && curve[i + 1].price >= price) {
      const t = (price - curve[i].price) / (curve[i + 1].price - curve[i].price);
      return curve[i].impulse + t * (curve[i + 1].impulse - curve[i].impulse);
    }
  }
  return 0;
}

function computeSlope(curve: HedgeImpulsePoint[], price: number): number {
  if (curve.length < 3) return 0;
  const step = curve[1].price - curve[0].price;
  const above = interpolateAtPrice(curve, price + step);
  const below = interpolateAtPrice(curve, price - step);
  return (above - below) / (2 * step);
}

function findZeroCrossings(curve: HedgeImpulsePoint[]): ZeroCrossing[] {
  const crossings: ZeroCrossing[] = [];
  for (let i = 0; i < curve.length - 1; i++) {
    const a = curve[i].impulse;
    const b = curve[i + 1].impulse;
    if (a * b < 0) {
      const t = Math.abs(a) / (Math.abs(a) + Math.abs(b));
      const crossPrice = curve[i].price + t * (curve[i + 1].price - curve[i].price);
      crossings.push({ price: crossPrice, direction: b > a ? "rising" : "falling" });
    }
  }
  return crossings;
}

function findExtrema(curve: HedgeImpulsePoint[]): ImpulseExtremum[] {
  const extrema: ImpulseExtremum[] = [];
  for (let i = 1; i < curve.length - 1; i++) {
    const prev = curve[i - 1].impulse;
    const curr = curve[i].impulse;
    const next = curve[i + 1].impulse;

    if (curr > prev && curr > next && curr > 0) {
      extrema.push({ price: curve[i].price, impulse: curr, type: "basin" });
    }
    if (curr < prev && curr < next && curr < 0) {
      extrema.push({ price: curve[i].price, impulse: curr, type: "peak" });
    }
  }
  return extrema;
}

function computeAsymmetry(curve: HedgeImpulsePoint[], spot: number): DirectionalAsymmetry {
  const step = curve.length > 1 ? curve[1].price - curve[0].price : 1;
  let upsideIntegral = 0;
  let downsideIntegral = 0;

  for (const point of curve) {
    if (point.price > spot) upsideIntegral += point.impulse * step;
    if (point.price < spot) downsideIntegral += point.impulse * step;
  }

  const threshold = Math.max(Math.abs(upsideIntegral), Math.abs(downsideIntegral)) * 0.1;
  let bias: "up" | "down" | "neutral" = "neutral";
  if (upsideIntegral < downsideIntegral - threshold) bias = "up";
  else if (downsideIntegral < upsideIntegral - threshold) bias = "down";

  const denominator = Math.abs(downsideIntegral) || 1e-10;
  return { upside: upsideIntegral, downside: downsideIntegral, bias, asymmetryRatio: Math.abs(upsideIntegral) / denominator };
}

function classifyRegime(
  impulseAtSpot: number,
  asymmetry: DirectionalAsymmetry,
  curve: HedgeImpulsePoint[],
): ImpulseRegime {
  const meanAbsImpulse = curve.reduce((sum, p) => sum + Math.abs(p.impulse), 0) / (curve.length || 1);
  if (meanAbsImpulse === 0) return "neutral";

  const normalized = impulseAtSpot / meanAbsImpulse;

  if (normalized > 0.5) return "pinned";
  if (normalized < -0.3) {
    if (asymmetry.bias === "up") return "squeeze-up";
    if (asymmetry.bias === "down") return "squeeze-down";
    return "expansion";
  }
  if (asymmetry.bias === "up" && asymmetry.asymmetryRatio > 1.5) return "squeeze-up";
  if (asymmetry.bias === "down" && asymmetry.asymmetryRatio > 1.5) return "squeeze-down";
  return "neutral";
}

// ============================================================================
// Helpers
// ============================================================================

function detectStrikeSpacing(strikes: number[]): number {
  if (strikes.length < 2) return 1;
  const gaps: number[] = [];
  for (let i = 1; i < strikes.length; i++) {
    const gap = Math.abs(strikes[i] - strikes[i - 1]);
    if (gap > 0) gaps.push(gap);
  }
  if (gaps.length === 0) return 1;

  // Modal gap (most common spacing)
  const gapCounts = new Map<number, number>();
  for (const gap of gaps) {
    const rounded = Math.round(gap * 100) / 100;
    gapCounts.set(rounded, (gapCounts.get(rounded) || 0) + 1);
  }

  let modalGap = gaps[0];
  let maxCount = 0;
  for (const [gap, count] of gapCounts) {
    if (count > maxCount) { maxCount = count; modalGap = gap; }
  }
  return modalGap;
}

function timeToExpiry(expirationStr: string): number {
  const expDate = new Date(expirationStr + "T16:00:00-04:00");
  const diffMs = expDate.getTime() - Date.now();
  if (diffMs <= 0) return 0;
  return diffMs / (365.25 * 24 * 3600 * 1000);
}

function emptyImpulseCurve(spot: number, k: number, now: number): HedgeImpulseCurve {
  return {
    spot,
    computedAt: now,
    spotVolCoupling: k,
    kernelWidth: 0,
    strikeSpacing: 0,
    curve: [],
    impulseAtSpot: 0,
    slopeAtSpot: 0,
    zeroCrossings: [],
    extrema: [],
    asymmetry: { upside: 0, downside: 0, bias: "neutral", asymmetryRatio: 1 },
    regime: "neutral",
    nearestAttractorAbove: null,
    nearestAttractorBelow: null,
  };
}