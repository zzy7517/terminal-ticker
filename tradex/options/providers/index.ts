/**
 * Options Provider Registry
 *
 * Factory for creating the appropriate data provider based on configuration.
 */

import type { OptionsConfig } from "../domain.js";
import type { OptionsDataProvider } from "./base.js";
import { DeribitProvider } from "./deribit.js";
import { YFinanceProvider } from "./yfinance.js";
import { TradierProvider } from "./tradier.js";

export { type OptionsDataProvider, RateLimiter } from "./base.js";
export { YFinanceProvider } from "./yfinance.js";
export { DeribitProvider } from "./deribit.js";
export { TradierProvider } from "./tradier.js";


/**
 * Create the primary options data provider based on config.
 * For US stocks/ETFs (SPY, QQQ, AAPL, GLD, IBIT, etc.) → YFinance
 * For crypto (BTC, ETH) → Deribit
 */
export function createProvider(config: OptionsConfig): OptionsDataProvider {
  switch (config.provider) {
    case "yfinance":
      return new YFinanceProvider(config.pollIntervalSeconds > 30 ? 30 : 20);

    case "deribit":
      return new DeribitProvider(config.deribit?.currencies ?? ["BTC", "ETH"]);

    case "tradier":
      // Tradier needs an API key; without one, fall back to the free
      // Yahoo Finance provider so the service still works.
      if (!config.tradier?.apiKey) {
        console.warn("[options] provider=tradier but no tradier.api_key configured — falling back to Yahoo Finance");
        return new YFinanceProvider();
      }
      return new TradierProvider(
        config.tradier.apiKey,
        config.tradier.baseUrl,
        config.pollIntervalSeconds > 30 ? 60 : 30,
      );

    default:
      return new YFinanceProvider();
  }
}

/**
 * Determine which provider to use for a given symbol.
 * Crypto symbols go to Deribit, everything else goes to the primary provider.
 */
const CRYPTO_SYMBOLS = new Set(["BTC", "ETH", "SOL"]);

export function resolveProviderForSymbol(
  symbol: string,
  primary: OptionsDataProvider,
  deribit: DeribitProvider | null,
): OptionsDataProvider {
  if (deribit && CRYPTO_SYMBOLS.has(symbol.toUpperCase())) {
    return deribit;
  }
  return primary;
}
