/**
 * Options & GEX Analysis Module
 *
 * Direct observation of institutional options behavior:
 * - GEX (Gamma Exposure) calculation
 * - Dealer positioning (Charm, Vanna hidden flows)
 * - Key levels (Call Wall, Put Wall, Zero Gamma Level)
 * - Unusual activity detection
 *
 * Free data sources:
 * - Yahoo Finance: Any US stock/ETF (SPY, QQQ, AAPL, NVDA, GLD, IBIT, etc.)
 * - Deribit: BTC/ETH options (public API, no key needed)
 */

export type {
  ActivitySignal,
  CharmVannaFlow,
  GammaRegime,
  GexSnapshot,
  KeyLevels,
  OptionChain,
  OptionQuote,
  OptionsConfig,
  StrikeGex,
  UnusualActivity,
} from "./domain.js";

export { DEFAULT_OPTIONS_CONFIG } from "./domain.js";
export { GexCalculator } from "./gex_calculator.js";
export * from "./greeks.js";
export { createProvider, DeribitProvider, type OptionsDataProvider, YFinanceProvider } from "./providers/index.js";
export { OptionsService } from "./service.js";
export { OptionsStore } from "./store.js";

// Advanced modules
export {
  buildIVSurface,
  deriveRegimeParams,
  deriveSpotVolCoupling,
  interpolateIVAtStrike,
  type IVSurface,
  type MarketRegime,
  type RegimeParams,
} from "./iv_surface.js";

export {
  computeHedgeImpulseCurve,
  type DirectionalAsymmetry,
  type HedgeImpulseConfig,
  type HedgeImpulseCurve,
  type HedgeImpulsePoint,
  type ImpulseExtremum,
  type ImpulseRegime,
  type ZeroCrossing,
} from "./hedge_impulse.js";

export {
  computePressureCloud,
  type PressureCloud,
  type PressureCloudConfig,
  type PressureLevel,
  type PressureZone,
  type RegimeEdge,
} from "./pressure_cloud.js";

export {
  calculateFullExposure,
  type ExposureModeBreakdown,
  type ExposureOptions,
  type ExposurePerExpiry,
  type ExposureVector,
  type StrikeExposure,
} from "./exposure.js";
