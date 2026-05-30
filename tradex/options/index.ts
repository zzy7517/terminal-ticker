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
  OiRecord,
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
