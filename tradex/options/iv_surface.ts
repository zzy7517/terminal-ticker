/**
 * IV Surface Construction & Regime Derivation
 *
 * Builds an implied volatility surface from option chain data and derives
 * market regime parameters purely from the surface characteristics:
 * - ATM IV → regime classification (calm/normal/stressed/crisis)
 * - Skew slope → implied spot-vol correlation
 * - Smile curvature → implied vol-of-vol
 *
 * No external data needed — the IV surface IS the market's state.
 *
 * Reference: FullStackCraft/floe regime.ts
 */

import type { OptionQuote } from "./domain.js";

// ============================================================================
// Types
// ============================================================================

export type MarketRegime = "calm" | "normal" | "stressed" | "crisis";

export interface RegimeParams {
  /** ATM implied volatility (decimal, e.g., 0.18 = 18%) */
  atmIV: number;
  /** Implied spot-vol correlation derived from skew slope */
  impliedSpotVolCorr: number;
  /** Implied vol-of-vol derived from smile curvature */
  impliedVolOfVol: number;
  /** Regime classification */
  regime: MarketRegime;
  /** Expected daily spot move (decimal fraction of spot) */
  expectedDailySpotMove: number;
  /** Expected daily vol move (decimal) */
  expectedDailyVolMove: number;
}

export interface IVSurface {
  /** Sorted strike prices */
  strikes: number[];
  /** Smoothed IV values at each strike (as percent, e.g., 25.0 = 25%) */
  smoothedIVs: number[];
  /** Spot price used for construction */
  spot: number;
  /** Expiration (ISO date string) */
  expiration: string;
}

// ============================================================================
// IV Surface Construction
// ============================================================================

/**
 * Build an IV surface from option quotes for a single expiration.
 * Uses call/put mid-IV, preferring calls above spot and puts below (OTM preference).
 */
export function buildIVSurface(
  contracts: OptionQuote[],
  spotPrice: number,
  expiration: string,
): IVSurface | null {
  // Group by strike, prefer OTM quotes (more liquid, tighter spread)
  const ivByStrike = new Map<number, number>();

  for (const c of contracts) {
    if (c.expiration !== expiration) continue;
    if (!c.impliedVol || c.impliedVol <= 0.01 || c.impliedVol > 5.0) continue;

    const existing = ivByStrike.get(c.strike);
    const ivPct = c.impliedVol * 100; // Convert to percent for surface

    if (existing === undefined) {
      // Prefer OTM: calls above spot, puts below
      const isOtm = (c.type === "call" && c.strike > spotPrice) ||
                     (c.type === "put" && c.strike < spotPrice);
      if (isOtm || !ivByStrike.has(c.strike)) {
        ivByStrike.set(c.strike, ivPct);
      }
    } else {
      // If we have a value, only replace with OTM
      const isOtm = (c.type === "call" && c.strike > spotPrice) ||
                     (c.type === "put" && c.strike < spotPrice);
      if (isOtm) {
        ivByStrike.set(c.strike, ivPct);
      }
    }
  }

  if (ivByStrike.size < 3) return null;

  // Sort by strike
  const entries = Array.from(ivByStrike.entries()).sort((a, b) => a[0] - b[0]);
  const strikes = entries.map(e => e[0]);
  const rawIVs = entries.map(e => e[1]);

  // Simple smoothing: 3-point moving average (preserves ends)
  const smoothedIVs = smoothIV(rawIVs);

  return { strikes, smoothedIVs, spot: spotPrice, expiration };
}

/** 3-point moving average smoothing */
function smoothIV(ivs: number[]): number[] {
  if (ivs.length <= 2) return [...ivs];
  const result = new Array<number>(ivs.length);
  result[0] = ivs[0];
  result[ivs.length - 1] = ivs[ivs.length - 1];
  for (let i = 1; i < ivs.length - 1; i++) {
    result[i] = (ivs[i - 1] + ivs[i] + ivs[i + 1]) / 3;
  }
  return result;
}

// ============================================================================
// Regime Derivation
// ============================================================================

/**
 * Derive regime parameters from an IV surface.
 * All regime info comes from the surface itself — no external data needed.
 */
export function deriveRegimeParams(
  surface: IVSurface,
): RegimeParams {
  const { strikes, smoothedIVs, spot } = surface;

  const atmIV = interpolateIVAtStrike(strikes, smoothedIVs, spot) / 100;
  const skew = calculateSkewAtSpot(strikes, smoothedIVs, spot);
  const impliedSpotVolCorr = skewToCorrelation(skew);
  const curvature = calculateCurvatureAtSpot(strikes, smoothedIVs, spot);
  const impliedVolOfVol = curvatureToVolOfVol(curvature, atmIV);
  const regime = ivToRegime(atmIV);
  const expectedDailySpotMove = atmIV / Math.sqrt(252);
  const expectedDailyVolMove = impliedVolOfVol / Math.sqrt(252);

  return {
    atmIV,
    impliedSpotVolCorr,
    impliedVolOfVol,
    regime,
    expectedDailySpotMove,
    expectedDailyVolMove,
  };
}

// ============================================================================
// Surface Analysis Helpers
// ============================================================================

/** Linearly interpolate IV at an arbitrary strike */
export function interpolateIVAtStrike(
  strikes: number[],
  ivs: number[],
  targetStrike: number,
): number {
  if (strikes.length === 0 || ivs.length === 0) return 20; // default 20%
  if (strikes.length === 1) return ivs[0];
  if (targetStrike <= strikes[0]) return ivs[0];
  if (targetStrike >= strikes[strikes.length - 1]) return ivs[ivs.length - 1];

  for (let i = 0; i < strikes.length - 1; i++) {
    if (strikes[i] <= targetStrike && strikes[i + 1] >= targetStrike) {
      const t = (targetStrike - strikes[i]) / (strikes[i + 1] - strikes[i]);
      return ivs[i] + t * (ivs[i + 1] - ivs[i]);
    }
  }

  return ivs[0];
}

/** Calculate skew (dIV/dK normalized by spot) at current spot */
function calculateSkewAtSpot(strikes: number[], ivs: number[], spot: number): number {
  if (strikes.length < 2) return 0;

  // Find bracketing strikes around spot
  let lowerIdx = 0;
  let upperIdx = strikes.length - 1;

  for (let i = 0; i < strikes.length - 1; i++) {
    if (strikes[i] <= spot && strikes[i + 1] >= spot) {
      lowerIdx = i;
      upperIdx = i + 1;
      break;
    }
  }

  const dIV = ivs[upperIdx] - ivs[lowerIdx];
  const dK = strikes[upperIdx] - strikes[lowerIdx];

  return dK > 0 ? (dIV / dK) * spot : 0;
}

/** Calculate curvature (d²IV/dK²) at current spot, normalized by spot² */
function calculateCurvatureAtSpot(strikes: number[], ivs: number[], spot: number): number {
  if (strikes.length < 3) return 0;

  // Find closest strike to spot
  let centerIdx = 0;
  for (let i = 0; i < strikes.length; i++) {
    if (Math.abs(strikes[i] - spot) < Math.abs(strikes[centerIdx] - spot)) {
      centerIdx = i;
    }
  }

  if (centerIdx === 0 || centerIdx === strikes.length - 1) return 0;

  const h = (strikes[centerIdx + 1] - strikes[centerIdx - 1]) / 2;
  if (h <= 0) return 0;

  const ivMinus = ivs[centerIdx - 1];
  const iv = ivs[centerIdx];
  const ivPlus = ivs[centerIdx + 1];

  // Second derivative via finite differences, normalized by spot²
  return ((ivPlus - 2 * iv + ivMinus) / (h * h)) * spot * spot;
}

// ============================================================================
// Conversion Functions
// ============================================================================

/**
 * Convert skew to implied spot-vol correlation.
 * From stochastic vol models: skew ≈ ρ_SV × volOfVol / atmIV
 */
function skewToCorrelation(skew: number): number {
  const SKEW_TO_CORR_SCALE = 0.15;
  return Math.max(-0.95, Math.min(0.5, skew * SKEW_TO_CORR_SCALE));
}

/**
 * Convert curvature to implied vol-of-vol.
 * The "wings" of the smile encode the vol-of-vol.
 */
function curvatureToVolOfVol(curvature: number, atmIV: number): number {
  const VOL_OF_VOL_SCALE = 2.0;
  return Math.sqrt(Math.abs(curvature)) * VOL_OF_VOL_SCALE * atmIV;
}

/** Classify regime from ATM IV level */
function ivToRegime(atmIV: number): MarketRegime {
  if (atmIV < 0.15) return "calm";
  if (atmIV < 0.20) return "normal";
  if (atmIV < 0.35) return "stressed";
  return "crisis";
}

/**
 * Derive the spot-vol coupling coefficient k from regime params.
 * Used by Hedge Impulse Curve to combine GEX and VEX.
 *
 * From: dσ ≈ -k × (dS/S)
 * So: k = -ρ_SV × volOfVol × √252
 *
 * For equity indices, k typically falls in [4, 12].
 */
export function deriveSpotVolCoupling(params: RegimeParams): number {
  const { impliedSpotVolCorr, atmIV } = params;
  const k = -impliedSpotVolCorr * atmIV * Math.sqrt(252);
  return Math.max(2, Math.min(20, k));
}
