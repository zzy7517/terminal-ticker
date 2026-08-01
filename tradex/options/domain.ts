/**
 * Options & GEX Analysis - Domain Types
 *
 * Pure types and interfaces. No I/O.
 */

import type { IVSurface, RegimeParams } from "./iv-surface.js";
import type { HedgeImpulseCurve } from "./hedge-impulse.js";
import type { PressureCloud } from "./pressure-cloud.js";
import type { ExposurePerExpiry } from "./exposure.js";

// ============================================================================
// Core Option Data
// ============================================================================

export interface OptionQuote {
  symbol: string;           // Contract symbol (e.g., "SPY260601C00590000")
  underlying: string;       // Underlying symbol (e.g., "SPY")
  strike: number;
  expiration: string;       // ISO date "YYYY-MM-DD"
  type: "call" | "put";
  bid: number;
  ask: number;
  mid: number;
  openInterest: number;
  volume: number;
  impliedVol: number | null;  // Annualized IV (decimal, e.g., 0.25 = 25%)
  // Greeks (null if provider doesn't supply them — we calculate locally)
  delta: number | null;
  gamma: number | null;
  vega: number | null;
  theta: number | null;
}

export interface OptionChain {
  underlying: string;
  spotPrice: number;
  expiration: string;
  contracts: OptionQuote[];
  timestamp: number;        // Unix ms
  provider: string;
  /**
   * Units of underlying per contract. US equity options: 100 (default).
   * Deribit crypto options: 1 (OI is denominated in coins).
   */
  contractMultiplier?: number;
}

// ============================================================================
// GEX Calculation Results
// ============================================================================

export type GammaRegime = "long_gamma" | "short_gamma" | "neutral";

export interface StrikeGex {
  strike: number;
  callGex: number;
  putGex: number;
  netGex: number;
  callOi: number;
  putOi: number;
}

export interface KeyLevels {
  callWall: number;         // Highest call OI strike above spot
  putWall: number;          // Highest put OI strike below spot
  maxGammaStrike: number;   // Strike with max |GEX|
  zeroGammaLevel: number;   // Price where cumulative GEX = 0
  zglCrossingFound: boolean;
}

export interface CharmVannaFlow {
  charmFlow: number;        // $ flow from time decay (+ = dealers buy, - = sell)
  vannaFlow: number;        // $ flow from IV change (+ = dealers buy, - = sell)
  netHiddenFlow: number;    // charm + vanna combined ($)
  charmByStrike: Record<number, number>;
  vannaByStrike: Record<number, number>;
}

export interface GexSnapshot {
  timestamp: number;          // Unix ms
  symbol: string;
  spotPrice: number;
  netGex: number;
  netGexBillions: number;
  totalCallGex: number;
  totalPutGex: number;
  zeroGammaLevel: number;
  regime: GammaRegime;
  regimeDescription: string;
  dominantStrike: number;
  keyLevels: KeyLevels;
  gexByStrike: StrikeGex[];
  charmVanna: CharmVannaFlow | null;
  provider: string;
  // ── Advanced analytics (A modules) — optional, present when computable ──
  /** IV surface + derived market-regime parameters for the front expiration. */
  regimeParams: RegimeParams | null;
  /** Smoothed IV-by-strike surface for the front expiration. */
  ivSurface: IVSurface | null;
  /** Dealer hedge impulse curve (pin/breakout topology). */
  hedgeImpulse: HedgeImpulseCurve | null;
  /** Pressure cloud: stability/acceleration zones + regime edges. */
  pressureCloud: PressureCloud | null;
  /** Full 4D exposure (GEX/DEX/VEX/CHEX) per expiration. */
  exposure: ExposurePerExpiry[] | null;
}

// ============================================================================
// Configuration
// ============================================================================

export interface OptionsConfig {
  enabled: boolean;
  provider: "yfinance" | "tradier" | "deribit" | "marketdata";
  symbols: string[];
  pollIntervalSeconds: number;
  strikeRangePercent: number;
  riskFreeRate: number;
  dividendYield: number;
  tradier?: {
    apiKey: string;
    /** Raw TOML value (e.g. "${TRADIER_API_KEY}") preserved for round-trip writes. */
    apiKeyRaw?: string;
    baseUrl: string;
  };
  /** Optional fallback source (MarketData.app) used when the primary fails. */
  marketdata?: {
    /** Resolved key (env refs expanded) — used to talk to the API. */
    apiKey: string;
    /** Raw TOML value (e.g. "${MARKETDATA_API_KEY}") preserved for round-trip writes. */
    apiKeyRaw?: string;
    baseUrl: string;
    /** Max strikes fetched per side; caps credit use (1 credit/contract). Default 80. */
    strikeLimit?: number;
    /** Target near-term expiration in days-to-expiry. Default 7. */
    dte?: number;
    /** Outbound request cap per minute. Default derived from poll interval (15 or 30). */
    callsPerMinute?: number;
  };
  deribit?: {
    enabled: boolean;
    currencies: string[];
  };
  alerts: {
    minOiChange: number;
    minVolumeOiRatio: number;
    minPremium: number;
  };
}

export const DEFAULT_OPTIONS_CONFIG: OptionsConfig = {
  enabled: false,
  provider: "yfinance",
  symbols: ["SPY", "QQQ"],
  pollIntervalSeconds: 60,
  strikeRangePercent: 0.15,
  riskFreeRate: 0.0363,
  dividendYield: 0.015,
  deribit: {
    enabled: false,
    currencies: ["BTC", "ETH"],
  },
  alerts: {
    minOiChange: 1000,
    minVolumeOiRatio: 3.0,
    minPremium: 100_000,
  },
};

// ============================================================================
// Constants
// ============================================================================

export const CONTRACT_MULTIPLIER = 100;
export const ONE_PERCENT_MOVE = 0.01;
export const MIN_IV = 0.01;   // 1%
export const MAX_IV = 5.0;    // 500%

/** Regime thresholds in raw GEX dollars */
export const LONG_GAMMA_THRESHOLD = 1e9;   // +$1B
export const SHORT_GAMMA_THRESHOLD = -1e9; // -$1B
