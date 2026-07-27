/**
 * Options & GEX Analysis - GEX Calculator Engine
 *
 * Calculates Gamma Exposure, Zero Gamma Level, market regime, Charm/Vanna flows,
 * and key levels (Call Wall, Put Wall, Max Gamma Strike).
 *
 * Trader-facing baseline convention:
 *   - Calls contribute POSITIVE GEX
 *   - Puts contribute NEGATIVE GEX
 *   - Net GEX = Σ(Call GEX) + Σ(Put GEX)
 *
 * GEX Formula per contract:
 *   GEX_i = OI_i × Γ_i × 100 × S² × 0.01
 */

import {
  type CharmVannaFlow,
  CONTRACT_MULTIPLIER,
  type GammaRegime,
  type GexSnapshot,
  type KeyLevels,
  LONG_GAMMA_THRESHOLD,
  MAX_IV,
  MIN_IV,
  ONE_PERCENT_MOVE,
  type OptionChain,
  type OptionQuote,
  SHORT_GAMMA_THRESHOLD,
  type StrikeGex,
} from "./domain.js";
import { charm, gamma, vanna } from "./greeks.js";
import { yearsToExpiry } from "./expiry.js";

// ============================================================================
// GEX Calculator
// ============================================================================

export interface GexCalculatorOptions {
  riskFreeRate: number;
  dividendYield: number;
  /** Minutes of time advance for Charm calculation (default: 30) */
  charmTimeAdvanceMinutes?: number;
  /** IV bump for Vanna calculation (default: -0.01 = -1%) */
  vannaBump?: number;
}

export class GexCalculator {
  private readonly r: number;
  private readonly q: number;
  private readonly charmMinutes: number;
  private readonly vannaBump: number;

  constructor(options: GexCalculatorOptions) {
    this.r = options.riskFreeRate;
    this.q = options.dividendYield;
    this.charmMinutes = options.charmTimeAdvanceMinutes ?? 30;
    this.vannaBump = options.vannaBump ?? -0.01;
  }

  /**
   * Calculate full GEX snapshot from an options chain.
   */
  calculate(chain: OptionChain): GexSnapshot {
    const { spotPrice, contracts, underlying, provider, timestamp } = chain;
    const multiplier = chain.contractMultiplier ?? CONTRACT_MULTIPLIER;

    // Filter valid contracts
    const valid = contracts.filter(c => this.isValidContract(c));
    if (valid.length === 0) {
      return this.emptySnapshot(underlying, spotPrice, timestamp, provider);
    }

    // Calculate GEX for each contract
    const now = timestamp;
    const strikeMap = new Map<number, { callGex: number; putGex: number; callOi: number; putOi: number }>();

    let totalCallGex = 0;
    let totalPutGex = 0;

    for (const contract of valid) {
      const T = this.timeToExpiration(contract.expiration, now);
      if (T <= 0) continue;

      const iv = contract.impliedVol ?? 0;
      if (iv < MIN_IV || iv > MAX_IV) continue;

      // Calculate gamma
      const g = gamma(spotPrice, contract.strike, T, this.r, this.q, iv);

      // GEX = OI × Γ × multiplier × S² × 0.01
      const rawGex = contract.openInterest * g * multiplier * (spotPrice ** 2) * ONE_PERCENT_MOVE;

      // Sign convention: calls positive, puts negative
      const signedGex = contract.type === "call" ? rawGex : -rawGex;

      if (contract.type === "call") {
        totalCallGex += signedGex;
      } else {
        totalPutGex += signedGex;
      }

      // Aggregate by strike
      const entry = strikeMap.get(contract.strike) ?? { callGex: 0, putGex: 0, callOi: 0, putOi: 0 };
      if (contract.type === "call") {
        entry.callGex += signedGex;
        entry.callOi += contract.openInterest;
      } else {
        entry.putGex += signedGex;
        entry.putOi += contract.openInterest;
      }
      strikeMap.set(contract.strike, entry);
    }

    const netGex = totalCallGex + totalPutGex;

    // Build strike-level array
    const gexByStrike: StrikeGex[] = Array.from(strikeMap.entries())
      .map(([strike, data]) => ({
        strike,
        callGex: data.callGex,
        putGex: data.putGex,
        netGex: data.callGex + data.putGex,
        callOi: data.callOi,
        putOi: data.putOi,
      }))
      .sort((a, b) => a.strike - b.strike);

    // Key levels
    const keyLevels = this.findKeyLevels(gexByStrike, spotPrice);

    // Regime
    const { regime, description } = this.determineRegime(netGex);

    // Dominant strike
    const dominantStrike = gexByStrike.length > 0
      ? gexByStrike.reduce((max, s) => Math.abs(s.netGex) > Math.abs(max.netGex) ? s : max).strike
      : spotPrice;

    // Charm & Vanna
    const charmVanna = this.calculateCharmVanna(valid, spotPrice, now, multiplier);

    return {
      timestamp: now,
      symbol: underlying,
      spotPrice,
      netGex,
      netGexBillions: netGex / 1e9,
      totalCallGex,
      totalPutGex,
      zeroGammaLevel: keyLevels.zeroGammaLevel,
      regime,
      regimeDescription: description,
      dominantStrike,
      keyLevels,
      gexByStrike,
      charmVanna,
      provider,
      // Advanced analytics are attached later by OptionsService.enrichSnapshot
      regimeParams: null,
      ivSurface: null,
      hedgeImpulse: null,
      pressureCloud: null,
      exposure: null,
    };
  }

  // --------------------------------------------------------------------------
  // Key Levels
  // --------------------------------------------------------------------------

  private findKeyLevels(gexByStrike: StrikeGex[], spotPrice: number): KeyLevels {
    if (gexByStrike.length === 0) {
      return {
        callWall: spotPrice,
        putWall: spotPrice,
        maxGammaStrike: spotPrice,
        zeroGammaLevel: spotPrice,
        zglCrossingFound: false,
      };
    }

    // Call Wall: highest call OI strike above spot
    const callsAboveSpot = gexByStrike.filter(s => s.strike >= spotPrice && s.callOi > 0);
    const callWall = callsAboveSpot.length > 0
      ? callsAboveSpot.reduce((max, s) => s.callOi > max.callOi ? s : max).strike
      : gexByStrike[gexByStrike.length - 1].strike;

    // Put Wall: highest put OI strike below spot
    const putsBelowSpot = gexByStrike.filter(s => s.strike <= spotPrice && s.putOi > 0);
    const putWall = putsBelowSpot.length > 0
      ? putsBelowSpot.reduce((max, s) => s.putOi > max.putOi ? s : max).strike
      : gexByStrike[0].strike;

    // Max Gamma Strike
    const maxGammaStrike = gexByStrike.reduce((max, s) =>
      Math.abs(s.netGex) > Math.abs(max.netGex) ? s : max
    ).strike;

    // Zero Gamma Level (linear interpolation on cumulative GEX)
    const { zgl, found } = this.findZeroGammaLevel(gexByStrike, spotPrice);

    return {
      callWall,
      putWall,
      maxGammaStrike,
      zeroGammaLevel: zgl,
      zglCrossingFound: found,
    };
  }

  private findZeroGammaLevel(gexByStrike: StrikeGex[], spotPrice: number): { zgl: number; found: boolean } {
    if (gexByStrike.length < 2) return { zgl: spotPrice, found: false };

    // Cumulative GEX from lowest to highest strike
    const strikes = gexByStrike.map(s => s.strike);
    const gexValues = gexByStrike.map(s => s.netGex);

    const cumulative: number[] = [];
    let sum = 0;
    for (const gex of gexValues) {
      sum += gex;
      cumulative.push(sum);
    }

    // Check if all same sign (no crossing)
    if (cumulative.every(v => v >= 0)) return { zgl: strikes[0], found: false };
    if (cumulative.every(v => v <= 0)) return { zgl: strikes[strikes.length - 1], found: false };

    // Find zero crossing via linear interpolation
    for (let i = 0; i < cumulative.length - 1; i++) {
      if (cumulative[i] * cumulative[i + 1] < 0) {
        const x1 = strikes[i];
        const x2 = strikes[i + 1];
        const y1 = cumulative[i];
        const y2 = cumulative[i + 1];

        if (y2 - y1 === 0) continue;
        const zgl = x1 - y1 * (x2 - x1) / (y2 - y1);
        return { zgl, found: true };
      }
    }

    // Exact zero
    const zeroIdx = cumulative.findIndex(v => Math.abs(v) < 1e-8);
    if (zeroIdx >= 0) return { zgl: strikes[zeroIdx], found: true };

    return { zgl: spotPrice, found: false };
  }

  // --------------------------------------------------------------------------
  // Regime Detection
  // --------------------------------------------------------------------------

  determineRegime(netGex: number): { regime: GammaRegime; description: string } {
    if (netGex > LONG_GAMMA_THRESHOLD) {
      return {
        regime: "long_gamma",
        description: "Dealers are long gamma — expect dampened volatility, mean-reversion",
      };
    }
    if (netGex < SHORT_GAMMA_THRESHOLD) {
      return {
        regime: "short_gamma",
        description: "Dealers are short gamma — expect amplified volatility, trend acceleration",
      };
    }
    return {
      regime: "neutral",
      description: "Neutral positioning — no strong directional dealer bias",
    };
  }

  // --------------------------------------------------------------------------
  // Charm & Vanna Hidden Flows
  // --------------------------------------------------------------------------

  private calculateCharmVanna(
    contracts: OptionQuote[],
    spotPrice: number,
    nowMs: number,
    multiplier: number = CONTRACT_MULTIPLIER,
  ): CharmVannaFlow {
    let charmFlow = 0;
    let vannaFlow = 0;
    const charmByStrike: Record<number, number> = {};
    const vannaByStrike: Record<number, number> = {};

    const timeFraction = this.charmMinutes / (24 * 60); // fraction of a day

    for (const c of contracts) {
      const T = this.timeToExpiration(c.expiration, nowMs);
      if (T <= 0) continue;

      const iv = c.impliedVol ?? 0;
      if (iv < MIN_IV || iv > MAX_IV) continue;

      // Charm flow ($): OI × Charm × multiplier × timeFraction × S
      // (OI × ΔΔ × multiplier is share flow; × spot converts to dollars,
      // matching the CharmVannaFlow "$ flow" contract.)
      const charmVal = charm(spotPrice, c.strike, T, this.r, this.q, iv, c.type);
      const rawCharmFlow = c.openInterest * charmVal * multiplier * timeFraction * spotPrice;
      // Dealer positioning: short calls (negative), long puts (positive)
      const signedCharm = c.type === "call" ? -rawCharmFlow : rawCharmFlow;

      charmFlow += signedCharm;
      charmByStrike[c.strike] = (charmByStrike[c.strike] ?? 0) + signedCharm;

      // Vanna flow ($): OI × Vanna × ΔIV × multiplier × S
      const vannaVal = vanna(spotPrice, c.strike, T, this.r, this.q, iv);
      const rawVannaFlow = c.openInterest * vannaVal * this.vannaBump * multiplier * spotPrice;
      const signedVanna = c.type === "call" ? -rawVannaFlow : rawVannaFlow;

      vannaFlow += signedVanna;
      vannaByStrike[c.strike] = (vannaByStrike[c.strike] ?? 0) + signedVanna;
    }

    return {
      charmFlow,
      vannaFlow,
      netHiddenFlow: charmFlow + vannaFlow,
      charmByStrike,
      vannaByStrike,
    };
  }

  // --------------------------------------------------------------------------
  // Helpers
  // --------------------------------------------------------------------------

  private isValidContract(c: OptionQuote): boolean {
    if (c.openInterest <= 0) return false;
    if (c.impliedVol !== null && (c.impliedVol < MIN_IV || c.impliedVol > MAX_IV)) return false;
    if (c.strike <= 0) return false;
    return true;
  }

  /** Calculate time to expiration in years. Assumes 4:00 PM ET close on expiration date (DST-aware). */
  private timeToExpiration(expirationStr: string, nowMs: number): number {
    return yearsToExpiry(expirationStr, nowMs);
  }

  private emptySnapshot(symbol: string, spotPrice: number, timestamp: number, provider: string): GexSnapshot {
    return {
      timestamp,
      symbol,
      spotPrice,
      netGex: 0,
      netGexBillions: 0,
      totalCallGex: 0,
      totalPutGex: 0,
      zeroGammaLevel: spotPrice,
      regime: "neutral",
      regimeDescription: "No data available",
      dominantStrike: spotPrice,
      keyLevels: {
        callWall: spotPrice,
        putWall: spotPrice,
        maxGammaStrike: spotPrice,
        zeroGammaLevel: spotPrice,
        zglCrossingFound: false,
      },
      gexByStrike: [],
      charmVanna: null,
      provider,
      regimeParams: null,
      ivSurface: null,
      hedgeImpulse: null,
      pressureCloud: null,
      exposure: null,
    };
  }
}
