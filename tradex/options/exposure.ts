/**
 * Full 4D Greek Exposure Calculation
 *
 * Computes four orthogonal exposure dimensions per strike and per expiration:
 *
 *   GEX (Gamma Exposure) — $ hedging per 1% price move
 *   DEX (Delta Exposure)  — current net directional position
 *   VEX (Vanna Exposure)  — $ hedging per 1 vol-point move
 *   CHEX (Charm Exposure) — $ hedging per 1 day of time decay
 *
 * Three computation modes:
 *   canonical     — standard absolute exposure
 *   stateWeighted — weighted by current IV level and DTE
 *   flowDelta     — only the incremental change from new OI (liveOI - prevOI)
 *
 * Together they give the full structural picture of dealer flows:
 *   GEX  = what happens when price moves
 *   DEX  = current directional state
 *   VEX  = what happens when vol changes
 *   CHEX = what happens purely from time passing
 *
 * Reference: FullStackCraft/floe src/exposure/index.ts
 */

import type { OptionQuote } from "./domain.js";
import { CONTRACT_MULTIPLIER, MIN_IV, MAX_IV, ONE_PERCENT_MOVE } from "./domain.js";
import { gamma, delta, vanna, charm } from "./greeks.js";

// ============================================================================
// Types
// ============================================================================

export interface ExposureVector {
  gammaExposure: number;  // GEX: $ per 1% spot move
  deltaExposure: number;  // DEX: net directional $ exposure
  vannaExposure: number;  // VEX: $ per 1 vol-point change
  charmExposure: number;  // CHEX: $ per 1 day time decay
  netExposure: number;    // Sum of all four
}

export interface StrikeExposure extends ExposureVector {
  strikePrice: number;
}

export interface ExposureModeBreakdown {
  totalGammaExposure: number;
  totalDeltaExposure: number;
  totalVannaExposure: number;
  totalCharmExposure: number;
  totalNetExposure: number;
  /** Strike with highest positive GEX */
  strikeOfMaxGamma: number;
  /** Strike with most negative GEX */
  strikeOfMinGamma: number;
  /** Per-strike detail */
  strikeExposures: StrikeExposure[];
}

export interface ExposurePerExpiry {
  spotPrice: number;
  expiration: string;
  /** Time to expiration in years */
  tte: number;
  /** Standard mode */
  canonical: ExposureModeBreakdown;
  /** State-weighted: Vanna × IV level, Charm × DTE */
  stateWeighted: ExposureModeBreakdown;
  /** Flow-delta: only OI changes */
  flowDelta: ExposureModeBreakdown;
}

export interface ExposureOptions {
  riskFreeRate?: number;
  dividendYield?: number;
  /** Timestamp for time-to-expiry calculation (default: now) */
  asOfTimestamp?: number;
}

// ============================================================================
// Main Calculation
// ============================================================================

/**
 * Calculate full 4D exposure (GEX/DEX/VEX/CHEX) across all expirations.
 *
 * @param contracts - All option quotes (must include OI and IV)
 * @param spotPrice - Current underlying spot price
 * @param options - Calculation options
 * @param previousOI - Optional map of {contractSymbol → previousOI} for flowDelta mode
 */
export function calculateFullExposure(
  contracts: OptionQuote[],
  spotPrice: number,
  options: ExposureOptions = {},
  previousOI?: Map<string, number>,
): ExposurePerExpiry[] {
  const {
    riskFreeRate = 0.0363,
    dividendYield = 0.015,
    asOfTimestamp = Date.now(),
  } = options;

  // Group by expiration
  const byExpiry = new Map<string, OptionQuote[]>();
  for (const c of contracts) {
    if (!isValidForExposure(c)) continue;
    const list = byExpiry.get(c.expiration) ?? [];
    list.push(c);
    byExpiry.set(c.expiration, list);
  }

  const results: ExposurePerExpiry[] = [];

  for (const [expiration, expiryContracts] of byExpiry) {
    const T = timeToExpiry(expiration, asOfTimestamp);
    if (T <= 0) continue;

    const daysToExpiry = T * 365.25;

    // Group by strike, pairing calls and puts
    const strikeMap = new Map<number, { calls: OptionQuote[]; puts: OptionQuote[] }>();
    for (const c of expiryContracts) {
      const entry = strikeMap.get(c.strike) ?? { calls: [], puts: [] };
      if (c.type === "call") entry.calls.push(c);
      else entry.puts.push(c);
      strikeMap.set(c.strike, entry);
    }

    const canonicalStrikes: StrikeExposure[] = [];
    const stateWeightedStrikes: StrikeExposure[] = [];
    const flowDeltaStrikes: StrikeExposure[] = [];

    for (const [strike, { calls, puts }] of strikeMap) {
      // Use the first call/put at this strike (usually one per expiry)
      const callContract = calls[0];
      const putContract = puts[0];

      // === CANONICAL MODE ===
      const canonVec = computeCanonicalExposure(
        spotPrice, strike, T, riskFreeRate, dividendYield,
        callContract, putContract
      );
      canonicalStrikes.push({ strikePrice: strike, ...canonVec });

      // === STATE-WEIGHTED MODE ===
      const stateVec = computeStateWeightedExposure(
        spotPrice, strike, T, riskFreeRate, dividendYield,
        callContract, putContract, daysToExpiry
      );
      stateWeightedStrikes.push({ strikePrice: strike, ...stateVec });

      // === FLOW-DELTA MODE ===
      const flowVec = computeFlowDeltaExposure(
        spotPrice, strike, T, riskFreeRate, dividendYield,
        callContract, putContract, previousOI
      );
      flowDeltaStrikes.push({ strikePrice: strike, ...flowVec });
    }

    results.push({
      spotPrice,
      expiration,
      tte: T,
      canonical: buildBreakdown(canonicalStrikes),
      stateWeighted: buildBreakdown(stateWeightedStrikes),
      flowDelta: buildBreakdown(flowDeltaStrikes),
    });
  }

  // Sort by expiration
  return results.sort((a, b) => a.expiration.localeCompare(b.expiration));
}

// ============================================================================
// Per-Mode Calculations
// ============================================================================

function computeCanonicalExposure(
  S: number, K: number, T: number, r: number, q: number,
  callContract: OptionQuote | undefined,
  putContract: OptionQuote | undefined,
): ExposureVector {
  let gammaExposure = 0;
  let deltaExposure = 0;
  let vannaExposure = 0;
  let charmExposure = 0;

  if (callContract && callContract.impliedVol) {
    const iv = callContract.impliedVol;
    const oi = callContract.openInterest;
    const g = gamma(S, K, T, r, q, iv);
    const d = delta(S, K, T, r, q, iv, "call");
    const v = vanna(S, K, T, r, q, iv);
    const ch = charm(S, K, T, r, q, iv, "call");

    // Dealer is short calls (sold to customers) → negate
    gammaExposure += -oi * g * CONTRACT_MULTIPLIER * S * S * ONE_PERCENT_MOVE;
    deltaExposure += -oi * d * CONTRACT_MULTIPLIER * S;
    vannaExposure += -oi * v * CONTRACT_MULTIPLIER * S * ONE_PERCENT_MOVE;
    charmExposure += -oi * ch * CONTRACT_MULTIPLIER * S;
  }

  if (putContract && putContract.impliedVol) {
    const iv = putContract.impliedVol;
    const oi = putContract.openInterest;
    const g = gamma(S, K, T, r, q, iv);
    const d = delta(S, K, T, r, q, iv, "put");
    const v = vanna(S, K, T, r, q, iv);
    const ch = charm(S, K, T, r, q, iv, "put");

    // Dealer is long puts (bought from customers) → positive sign
    gammaExposure += oi * g * CONTRACT_MULTIPLIER * S * S * ONE_PERCENT_MOVE;
    deltaExposure += oi * d * CONTRACT_MULTIPLIER * S;
    vannaExposure += oi * v * CONTRACT_MULTIPLIER * S * ONE_PERCENT_MOVE;
    charmExposure += oi * ch * CONTRACT_MULTIPLIER * S;
  }

  return sanitizeVector({
    gammaExposure,
    deltaExposure,
    vannaExposure,
    charmExposure,
    netExposure: gammaExposure + deltaExposure + vannaExposure + charmExposure,
  });
}

function computeStateWeightedExposure(
  S: number, K: number, T: number, r: number, q: number,
  callContract: OptionQuote | undefined,
  putContract: OptionQuote | undefined,
  daysToExpiry: number,
): ExposureVector {
  // State-weighted: Vanna weighted by IV level, Charm weighted by DTE
  const canonical = computeCanonicalExposure(S, K, T, r, q, callContract, putContract);

  const callIV = callContract?.impliedVol ?? 0;
  const putIV = putContract?.impliedVol ?? 0;
  const avgIV = (callIV + putIV) / 2 || 0.20; // fallback to 20%

  return sanitizeVector({
    gammaExposure: canonical.gammaExposure, // Gamma already uses spot scaling
    deltaExposure: canonical.deltaExposure,
    vannaExposure: canonical.vannaExposure * avgIV, // Weight by current IV
    charmExposure: canonical.charmExposure * Math.max(daysToExpiry, 0), // Weight by DTE
    netExposure: canonical.gammaExposure + canonical.deltaExposure +
                 canonical.vannaExposure * avgIV +
                 canonical.charmExposure * Math.max(daysToExpiry, 0),
  });
}

function computeFlowDeltaExposure(
  S: number, K: number, T: number, r: number, q: number,
  callContract: OptionQuote | undefined,
  putContract: OptionQuote | undefined,
  previousOI?: Map<string, number>,
): ExposureVector {
  if (!previousOI) {
    return { gammaExposure: 0, deltaExposure: 0, vannaExposure: 0, charmExposure: 0, netExposure: 0 };
  }

  // Create synthetic contracts with OI = delta(OI) = current - previous
  let gammaExposure = 0;
  let deltaExposure = 0;
  let vannaExposure = 0;
  let charmExposure = 0;

  if (callContract && callContract.impliedVol) {
    const prevOI = previousOI.get(callContract.symbol) ?? callContract.openInterest;
    const oiDelta = callContract.openInterest - prevOI;
    if (oiDelta !== 0) {
      const iv = callContract.impliedVol;
      const g = gamma(S, K, T, r, q, iv);
      const d = delta(S, K, T, r, q, iv, "call");
      const v = vanna(S, K, T, r, q, iv);
      const ch = charm(S, K, T, r, q, iv, "call");

      gammaExposure += -oiDelta * g * CONTRACT_MULTIPLIER * S * S * ONE_PERCENT_MOVE;
      deltaExposure += -oiDelta * d * CONTRACT_MULTIPLIER * S;
      vannaExposure += -oiDelta * v * CONTRACT_MULTIPLIER * S * ONE_PERCENT_MOVE;
      charmExposure += -oiDelta * ch * CONTRACT_MULTIPLIER * S;
    }
  }

  if (putContract && putContract.impliedVol) {
    const prevOI = previousOI.get(putContract.symbol) ?? putContract.openInterest;
    const oiDelta = putContract.openInterest - prevOI;
    if (oiDelta !== 0) {
      const iv = putContract.impliedVol;
      const g = gamma(S, K, T, r, q, iv);
      const d = delta(S, K, T, r, q, iv, "put");
      const v = vanna(S, K, T, r, q, iv);
      const ch = charm(S, K, T, r, q, iv, "put");

      gammaExposure += oiDelta * g * CONTRACT_MULTIPLIER * S * S * ONE_PERCENT_MOVE;
      deltaExposure += oiDelta * d * CONTRACT_MULTIPLIER * S;
      vannaExposure += oiDelta * v * CONTRACT_MULTIPLIER * S * ONE_PERCENT_MOVE;
      charmExposure += oiDelta * ch * CONTRACT_MULTIPLIER * S;
    }
  }

  return sanitizeVector({
    gammaExposure,
    deltaExposure,
    vannaExposure,
    charmExposure,
    netExposure: gammaExposure + deltaExposure + vannaExposure + charmExposure,
  });
}

// ============================================================================
// Helpers
// ============================================================================

function buildBreakdown(strikes: StrikeExposure[]): ExposureModeBreakdown {
  if (strikes.length === 0) {
    return {
      totalGammaExposure: 0,
      totalDeltaExposure: 0,
      totalVannaExposure: 0,
      totalCharmExposure: 0,
      totalNetExposure: 0,
      strikeOfMaxGamma: 0,
      strikeOfMinGamma: 0,
      strikeExposures: [],
    };
  }

  const totalGammaExposure = strikes.reduce((s, x) => s + x.gammaExposure, 0);
  const totalDeltaExposure = strikes.reduce((s, x) => s + x.deltaExposure, 0);
  const totalVannaExposure = strikes.reduce((s, x) => s + x.vannaExposure, 0);
  const totalCharmExposure = strikes.reduce((s, x) => s + x.charmExposure, 0);
  const totalNetExposure = totalGammaExposure + totalDeltaExposure + totalVannaExposure + totalCharmExposure;

  const sorted = [...strikes].sort((a, b) => b.gammaExposure - a.gammaExposure);
  const strikeOfMaxGamma = sorted[0].strikePrice;
  const strikeOfMinGamma = sorted[sorted.length - 1].strikePrice;

  return {
    totalGammaExposure: sanitize(totalGammaExposure),
    totalDeltaExposure: sanitize(totalDeltaExposure),
    totalVannaExposure: sanitize(totalVannaExposure),
    totalCharmExposure: sanitize(totalCharmExposure),
    totalNetExposure: sanitize(totalNetExposure),
    strikeOfMaxGamma,
    strikeOfMinGamma,
    strikeExposures: strikes,
  };
}

function isValidForExposure(c: OptionQuote): boolean {
  if (c.openInterest <= 0) return false;
  if (!c.impliedVol || c.impliedVol < MIN_IV || c.impliedVol > MAX_IV) return false;
  if (c.strike <= 0) return false;
  return true;
}

function timeToExpiry(expirationStr: string, nowMs: number): number {
  const expDate = new Date(expirationStr + "T16:00:00-04:00");
  const diffMs = expDate.getTime() - nowMs;
  if (diffMs <= 0) return 0;
  return diffMs / (365.25 * 24 * 3600 * 1000);
}

function sanitizeVector(vec: ExposureVector): ExposureVector {
  return {
    gammaExposure: sanitize(vec.gammaExposure),
    deltaExposure: sanitize(vec.deltaExposure),
    vannaExposure: sanitize(vec.vannaExposure),
    charmExposure: sanitize(vec.charmExposure),
    netExposure: sanitize(vec.netExposure),
  };
}

function sanitize(value: number): number {
  return isFinite(value) && !isNaN(value) ? value : 0;
}