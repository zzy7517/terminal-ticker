/**
 * FlashAlpha Provider — Pre-computed GEX/DEX/VEX/CHEX from FlashAlpha Lab API
 *
 * Free tier: 5 requests/day (individual US equities only)
 * Basic ($79/mo): 100/day + ETFs (SPY, QQQ, SPX, VIX)
 *
 * API Docs: https://flashalpha.com/docs/lab-api-overview
 * Base URL: https://lab.flashalpha.com
 * Auth: X-Api-Key header
 *
 * Endpoints used:
 *   GET /v1/exposure/gex/{symbol}   — Gamma exposure by strike
 *   GET /v1/exposure/dex/{symbol}   — Delta exposure by strike
 *   GET /v1/exposure/vex/{symbol}   — Vanna exposure by strike
 *   GET /v1/exposure/chex/{symbol}  — Charm exposure by strike
 *   GET /v1/exposure/summary/{symbol} — Aggregate snapshot
 */

import type {
  GammaRegime,
  GexSnapshot,
  KeyLevels,
  OptionChain,
  StrikeGex,
  CharmVannaFlow,
} from "../domain.js";
import { OptionsDataProvider, RateLimiter } from "./base.js";

// ============================================================================
// FlashAlpha Response Types
// ============================================================================

interface FlashAlphaGexStrike {
  strike: number;
  call_gex: number;
  put_gex: number;
  net_gex: number;
  call_oi: number;
  put_oi: number;
  call_volume: number;
  put_volume: number;
  call_oi_change: number;
  put_oi_change: number;
}

interface FlashAlphaGexResponse {
  symbol: string;
  underlying_price: number;
  as_of: string;
  gamma_flip: number;
  net_gex: number;
  net_gex_label: "positive" | "negative";
  strikes: FlashAlphaGexStrike[];
}

interface FlashAlphaSummaryResponse {
  symbol: string;
  underlying_price: number;
  as_of: string;
  regime: string;
  gamma_flip: number;
  net_gex: number;
  net_dex: number;
  net_vex: number;
  net_chex: number;
  call_wall: number;
  put_wall: number;
  max_pain: number;
}

interface FlashAlphaExposureStrike {
  strike: number;
  call_exposure: number;
  put_exposure: number;
  net_exposure: number;
}

interface FlashAlphaExposureResponse {
  symbol: string;
  underlying_price: number;
  as_of: string;
  net_exposure: number;
  strikes: FlashAlphaExposureStrike[];
}

// ============================================================================
// FlashAlpha Provider
// ============================================================================

export interface FlashAlphaConfig {
  apiKey: string;
  baseUrl?: string;
}

export class FlashAlphaProvider implements OptionsDataProvider {
  readonly name = "flashalpha";
  readonly providesGreeks = true; // Returns pre-computed data
  readonly rateLimit = 5; // 5 per day on free tier
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly limiter: RateLimiter;

  constructor(config: FlashAlphaConfig) {
    this.apiKey = config.apiKey;
    this.baseUrl = config.baseUrl ?? "https://lab.flashalpha.com";
    // Free tier: 5/day. Be conservative.
    this.limiter = new RateLimiter(5, 86_400_000); // 5 per 24h
  }

  async getSpotPrice(_symbol: string): Promise<number> {
    throw new Error("FlashAlpha does not provide spot prices directly. Use getGexSnapshot().");
  }

  async getExpirations(_symbol: string): Promise<string[]> {
    return []; // FlashAlpha doesn't expose expirations
  }

  // FlashAlpha provides pre-computed GEX, not raw chains.
  async getOptionsChain(_symbol: string, _options?: { expiration?: string; strikeRangePercent?: number }): Promise<OptionChain> {
    return { underlying: "", spotPrice: 0, expiration: "", contracts: [], timestamp: Date.now(), provider: this.name };
  }

  async close(): Promise<void> { /* stateless HTTP */ }

  /**
   * Get pre-computed GEX snapshot directly from FlashAlpha.
   * This bypasses local Greeks calculation — data comes ready-to-use.
   */
  async getGexSnapshot(symbol: string): Promise<GexSnapshot | null> {
    const gexData = await this.fetchGex(symbol);
    if (!gexData) return null;

    // Optionally fetch VEX/CHEX for charm/vanna data
    const [vexData, chexData] = await Promise.all([
      this.fetchExposure(symbol, "vex").catch(() => null),
      this.fetchExposure(symbol, "chex").catch(() => null),
    ]);

    return this.buildSnapshot(gexData, vexData, chexData);
  }

  // --------------------------------------------------------------------------
  // API Calls
  // --------------------------------------------------------------------------

  private async fetchGex(symbol: string): Promise<FlashAlphaGexResponse | null> {
    return this.request<FlashAlphaGexResponse>(`/v1/exposure/gex/${encodeURIComponent(symbol)}`);
  }

  private async fetchExposure(symbol: string, type: "dex" | "vex" | "chex"): Promise<FlashAlphaExposureResponse | null> {
    return this.request<FlashAlphaExposureResponse>(`/v1/exposure/${type}/${encodeURIComponent(symbol)}`);
  }

  async fetchSummary(symbol: string): Promise<FlashAlphaSummaryResponse | null> {
    return this.request<FlashAlphaSummaryResponse>(`/v1/exposure/summary/${encodeURIComponent(symbol)}`);
  }

  private async request<T>(path: string): Promise<T | null> {
    await this.limiter.acquire();

    const url = `${this.baseUrl}${path}`;
    const resp = await fetch(url, {
      headers: {
        "X-Api-Key": this.apiKey,
        "Accept": "application/json",
      },
    });

    if (!resp.ok) {
      if (resp.status === 429) {
        console.warn(`[flashalpha] Rate limited on ${path}`);
        return null;
      }
      if (resp.status === 404) {
        return null;
      }
      console.error(`[flashalpha] ${resp.status} on ${path}: ${await resp.text().catch(() => "")}`);
      return null;
    }

    return resp.json() as Promise<T>;
  }

  // --------------------------------------------------------------------------
  // Build Snapshot
  // --------------------------------------------------------------------------

  private buildSnapshot(
    gex: FlashAlphaGexResponse,
    vex: FlashAlphaExposureResponse | null,
    chex: FlashAlphaExposureResponse | null,
  ): GexSnapshot {
    const spot = gex.underlying_price;
    const netGex = gex.net_gex;

    // Convert strikes
    const gexByStrike: StrikeGex[] = gex.strikes.map(s => ({
      strike: s.strike,
      callGex: s.call_gex,
      putGex: s.put_gex,
      netGex: s.net_gex,
      callOi: s.call_oi,
      putOi: s.put_oi,
    }));

    // Determine regime
    const regime: GammaRegime = gex.net_gex_label === "positive" ? "long_gamma" : "short_gamma";
    const regimeDescription = regime === "long_gamma"
      ? "Dealers are long gamma — expect dampened volatility, mean-reversion (via FlashAlpha)"
      : "Dealers are short gamma — expect amplified volatility, trend acceleration (via FlashAlpha)";

    // Key levels
    const callStrikes = gexByStrike.filter(s => s.strike >= spot);
    const putStrikes = gexByStrike.filter(s => s.strike <= spot);

    const callWall = callStrikes.length > 0
      ? callStrikes.reduce((max, s) => s.callOi > max.callOi ? s : max, callStrikes[0]).strike
      : spot;
    const putWall = putStrikes.length > 0
      ? putStrikes.reduce((max, s) => s.putOi > max.putOi ? s : max, putStrikes[0]).strike
      : spot;
    const maxGammaStrike = gexByStrike.length > 0
      ? gexByStrike.reduce((max, s) => Math.abs(s.netGex) > Math.abs(max.netGex) ? s : max, gexByStrike[0]).strike
      : spot;

    const keyLevels: KeyLevels = {
      callWall,
      putWall,
      maxGammaStrike,
      zeroGammaLevel: gex.gamma_flip,
      zglCrossingFound: true,
    };

    // Charm/Vanna flows from VEX and CHEX
    let charmVanna: CharmVannaFlow | null = null;
    if (vex || chex) {
      const vannaFlow = vex?.net_exposure ?? 0;
      const charmFlow = chex?.net_exposure ?? 0;
      const vannaByStrike: Record<number, number> = {};
      const charmByStrike: Record<number, number> = {};

      if (vex?.strikes) {
        for (const s of vex.strikes) vannaByStrike[s.strike] = s.net_exposure;
      }
      if (chex?.strikes) {
        for (const s of chex.strikes) charmByStrike[s.strike] = s.net_exposure;
      }

      charmVanna = {
        charmFlow,
        vannaFlow,
        netHiddenFlow: charmFlow + vannaFlow,
        charmByStrike,
        vannaByStrike,
      };
    }

    // Aggregate call/put GEX
    const totalCallGex = gexByStrike.reduce((sum, s) => sum + s.callGex, 0);
    const totalPutGex = gexByStrike.reduce((sum, s) => sum + s.putGex, 0);

    return {
      timestamp: new Date(gex.as_of).getTime(),
      symbol: gex.symbol,
      spotPrice: spot,
      netGex,
      netGexBillions: netGex / 1e9,
      totalCallGex,
      totalPutGex,
      zeroGammaLevel: gex.gamma_flip,
      regime,
      regimeDescription,
      dominantStrike: maxGammaStrike,
      keyLevels,
      gexByStrike,
      charmVanna,
      provider: "flashalpha",
    };
  }
}
