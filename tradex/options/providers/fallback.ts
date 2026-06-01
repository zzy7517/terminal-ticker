/**
 * Fallback Options Data Provider
 *
 * Wraps an ordered list of providers and tries them in sequence. The first
 * provider that returns a usable (non-empty) options chain wins; if it throws
 * (e.g. Yahoo Finance 429 rate-limiting) or yields an empty chain, the next
 * provider is attempted. This gives a primary/backup arrangement without the
 * GEX service needing to know which source actually answered.
 *
 * Example: [YFinanceProvider, MarketDataProvider] — use the free Yahoo feed
 * normally, transparently switch to MarketData.app when Yahoo is unavailable.
 */

import type { OptionChain } from "../domain.js";
import type { OptionsDataProvider } from "./base.js";

export class FallbackProvider implements OptionsDataProvider {
  readonly name: string;
  readonly providesGreeks: boolean;
  readonly rateLimit: number;

  private readonly providers: OptionsDataProvider[];

  /** @param providers Ordered list; index 0 is the primary, rest are backups. */
  constructor(providers: OptionsDataProvider[]) {
    const usable = providers.filter(Boolean);
    if (usable.length === 0) throw new Error("FallbackProvider requires at least one provider");
    this.providers = usable;
    this.name = usable.map((p) => p.name).join("+");
    // A chain has Greeks only if every provider can supply them; otherwise the
    // GEX calculator must be ready to compute locally regardless of which won.
    this.providesGreeks = usable.every((p) => p.providesGreeks);
    this.rateLimit = Math.min(...usable.map((p) => p.rateLimit));
  }

  async getOptionsChain(symbol: string, options?: {
    expiration?: string;
    strikeRangePercent?: number;
  }): Promise<OptionChain> {
    let lastError: unknown = null;
    for (let i = 0; i < this.providers.length; i++) {
      const provider = this.providers[i];
      try {
        const chain = await provider.getOptionsChain(symbol, options);
        if (chain.contracts.length > 0) {
          if (i > 0) console.log(`[options] ${symbol}: served by fallback provider "${provider.name}"`);
          return chain;
        }
        console.warn(`[options] ${symbol}: provider "${provider.name}" returned empty chain, trying next`);
      } catch (err) {
        lastError = err;
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[options] ${symbol}: provider "${provider.name}" failed (${msg}), trying next`);
      }
    }
    // All providers exhausted. Surface the last error if there was one, else an
    // empty chain so the caller treats it as "no contracts".
    if (lastError) throw lastError;
    return {
      underlying: symbol,
      spotPrice: 0,
      expiration: "",
      contracts: [],
      timestamp: Date.now(),
      provider: this.name,
    };
  }

  async getSpotPrice(symbol: string): Promise<number> {
    let lastError: unknown = null;
    for (const provider of this.providers) {
      try {
        const price = await provider.getSpotPrice(symbol);
        if (price > 0) return price;
      } catch (err) {
        lastError = err;
      }
    }
    if (lastError) throw lastError;
    return 0;
  }

  async getExpirations(symbol: string): Promise<string[]> {
    let lastError: unknown = null;
    for (const provider of this.providers) {
      try {
        const expirations = await provider.getExpirations(symbol);
        if (expirations.length > 0) return expirations;
      } catch (err) {
        lastError = err;
      }
    }
    if (lastError) throw lastError;
    return [];
  }

  async close(): Promise<void> {
    await Promise.all(this.providers.map((p) => p.close().catch(() => {})));
  }
}
