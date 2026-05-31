/**
 * Options Provider Registry
 *
 * Factory for creating the appropriate data provider based on configuration.
 */

import type { OptionsConfig } from "../domain.js";
import type { OptionsDataProvider } from "./base.js";
import { DeribitProvider } from "./deribit.js";
import { YFinanceProvider } from "./yfinance.js";

export { type OptionsDataProvider, RateLimiter } from "./base.js";
export { YFinanceProvider } from "./yfinance.js";
export { DeribitProvider } from "./deribit.js";


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
      if (!config.tradier?.apiKey) {
        return new YFinanceProvider();
      }
      // TODO: Implement TradierProvider when key is available
      return new YFinanceProvider();

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
