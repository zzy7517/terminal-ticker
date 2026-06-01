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
import { MarketDataProvider } from "./marketdata.js";
import { FallbackProvider } from "./fallback.js";

export { type OptionsDataProvider, RateLimiter } from "./base.js";
export { YFinanceProvider } from "./yfinance.js";
export { DeribitProvider } from "./deribit.js";
export { TradierProvider } from "./tradier.js";
export { MarketDataProvider } from "./marketdata.js";
export { FallbackProvider } from "./fallback.js";


/** Number of strikes (per side) requested from MarketData.app. */
const MARKETDATA_STRIKE_LIMIT = 80;

/** Construct a MarketData.app provider from config, or null if no key. */
function createMarketDataProvider(config: OptionsConfig): MarketDataProvider | null {
  const md = config.marketdata;
  const mdKey = md?.apiKey;
  if (!mdKey) return null;
  // Configured overrides win; otherwise fall back to the derived/default values.
  const callsPerMinute = md?.callsPerMinute ?? (config.pollIntervalSeconds > 30 ? 30 : 15);
  return new MarketDataProvider(
    mdKey,
    md?.baseUrl,
    callsPerMinute,
    {
      strikeLimit: md?.strikeLimit ?? MARKETDATA_STRIKE_LIMIT,
      dte: md?.dte,
    },
  );
}

/** A free Yahoo Finance provider used as the no-key backup source. */
function createYFinanceProvider(config: OptionsConfig): YFinanceProvider {
  return new YFinanceProvider(config.pollIntervalSeconds > 30 ? 30 : 20);
}

/**
 * Create the equity/ETF options data provider.
 *
 * Default arrangement (provider = "marketdata"): MarketData.app is primary and
 * Yahoo Finance is the free no-key backup, so a MarketData failure or empty
 * chain transparently falls through to Yahoo.
 *
 * provider = "yfinance": Yahoo is primary; MarketData.app (if a key is set)
 * becomes the backup — the original arrangement, kept for flexibility.
 *
 * Crypto (Deribit) is handled separately and never wrapped.
 */
export function createProvider(config: OptionsConfig): OptionsDataProvider {
  // Deribit is crypto-only; an equity fallback would never apply.
  if (config.provider === "deribit") {
    return new DeribitProvider(config.deribit?.currencies ?? ["BTC", "ETH"]);
  }

  // Tradier as primary (when an API key is configured).
  if (config.provider === "tradier") {
    if (!config.tradier?.apiKey) {
      console.warn("[options] provider=tradier but no tradier.api_key configured — falling back to Yahoo Finance");
      return createYFinanceProvider(config);
    }
    return new TradierProvider(
      config.tradier.apiKey,
      config.tradier.baseUrl,
      config.pollIntervalSeconds > 30 ? 60 : 30,
    );
  }

  const marketData = createMarketDataProvider(config);
  const yfinance = createYFinanceProvider(config);

  // provider = "marketdata": MarketData primary, Yahoo backup.
  if (config.provider === "marketdata") {
    if (!marketData) {
      console.warn("[options] provider=marketdata but no marketdata.api_key configured — using Yahoo Finance only");
      return yfinance;
    }
    console.log(`[options] Fallback enabled: ${marketData.name} → ${yfinance.name}`);
    return new FallbackProvider([marketData, yfinance]);
  }

  // provider = "yfinance" (default): Yahoo primary, MarketData backup if keyed.
  if (marketData) {
    console.log(`[options] Fallback enabled: ${yfinance.name} → ${marketData.name}`);
    return new FallbackProvider([yfinance, marketData]);
  }
  return yfinance;
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
