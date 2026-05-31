/**
 * Options Provider Registry
 *
 * Factory for creating the appropriate data provider based on configuration.
 */

import type { OptionsConfig } from "../domain.js";
import type { OptionsDataProvider } from "./base.js";
import { DeribitProvider } from "./deribit.js";
import { YFinanceProvider } from "./yfinance.js";
import { FlashAlphaProvider, type FlashAlphaConfig } from "./flashalpha.js";
import { Zer0dteProvider, type McpToolCaller, ZER0DTE_MCP_CONFIG } from "./zer0dte.js";


export { type OptionsDataProvider, RateLimiter } from "./base.js";
export { YFinanceProvider } from "./yfinance.js";
export { DeribitProvider } from "./deribit.js";
export { FlashAlphaProvider, type FlashAlphaConfig } from "./flashalpha.js";
export { Zer0dteProvider, type McpToolCaller, ZER0DTE_MCP_CONFIG, ZER0DTE_TOOLS, getZer0dteMcpEntry } from "./zer0dte.js";


/**
 * Create the primary options data provider based on config.
 * For US stocks/ETFs (SPY, QQQ, AAPL, GLD, IBIT, etc.) → YFinance
 * For crypto (BTC, ETH) → Deribit
 * For pre-computed GEX → FlashAlpha
 */
export function createProvider(config: OptionsConfig): OptionsDataProvider {
  switch (config.provider) {
    case "yfinance":
      return new YFinanceProvider(config.pollIntervalSeconds > 30 ? 30 : 20);

    case "deribit":
      return new DeribitProvider(config.deribit?.currencies ?? ["BTC", "ETH"]);

    case "flashalpha":
      if (!config.flashalpha?.apiKey) {
        console.warn("[options] FlashAlpha requires API key (FLASHALPHA_API_KEY or config). Falling back to yfinance.");
        return new YFinanceProvider();
      }
      return new FlashAlphaProvider({ apiKey: config.flashalpha.apiKey, baseUrl: config.flashalpha.baseUrl });

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
 * Create ZER0DTE provider (requires MCP caller, SPX only).
 * Returns null if no MCP caller is available.
 */
export function createZer0dteProvider(mcpCaller: McpToolCaller | null, serverName?: string): Zer0dteProvider | null {
  if (!mcpCaller) return null;
  return new Zer0dteProvider(mcpCaller, serverName);
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
