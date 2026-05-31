/**
 * Options Data Provider - Base Interface
 *
 * All providers must implement this interface. Providers fetch options chain data
 * from external sources and return normalized OptionChain objects.
 */

import type { GexSnapshot, OptionChain } from "../domain.js";

export interface OptionsDataProvider {
  /** Provider identifier (e.g., "yfinance", "deribit", "tradier") */
  readonly name: string;

  /** Whether this provider returns Greeks directly (no local calculation needed) */
  readonly providesGreeks: boolean;

  /** Rate limit: max requests per minute */
  readonly rateLimit: number;

  /** Get the current spot price for a symbol */
  getSpotPrice(symbol: string): Promise<number>;

  /** Get available expiration dates */
  getExpirations(symbol: string): Promise<string[]>;

  /**
   * Get the full options chain for a symbol.
   * If expiration is not provided, uses the nearest expiration.
   * Filters to ±strikeRangePercent around spot.
   */
  getOptionsChain(symbol: string, options?: {
    expiration?: string;
    strikeRangePercent?: number;
  }): Promise<OptionChain>;

  /**
   * Get a pre-computed GEX snapshot directly from the provider.
   * Optional — providers that ship ready-to-use GEX can implement this to
   * bypass local Greeks/GEX calculation. The built-in providers (YFinance,
   * Deribit) return null and rely on local calculation.
   */
  getGexSnapshot?(symbol: string): Promise<GexSnapshot | null>;

  /** Clean up resources (close HTTP connections, etc.) */
  close(): Promise<void>;
}

/**
 * Simple rate limiter for API calls.
 */
export class RateLimiter {
  private tokens: number;
  private lastRefill: number;
  private readonly maxTokens: number;
  private readonly refillRate: number; // tokens per ms

  /**
   * @param maxCalls Maximum number of calls allowed in the window
   * @param windowMs Time window in milliseconds (default: 60_000 = 1 minute)
   */
  constructor(maxCalls: number, windowMs = 60_000) {
    this.maxTokens = maxCalls;
    this.tokens = maxCalls;
    this.lastRefill = Date.now();
    this.refillRate = maxCalls / windowMs;
  }

  async acquire(): Promise<void> {
    this.refill();
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return;
    }
    // Wait until a token is available
    const waitMs = Math.ceil((1 - this.tokens) / this.refillRate);
    await new Promise(resolve => setTimeout(resolve, waitMs));
    this.refill();
    this.tokens -= 1;
  }

  private refill(): void {
    const now = Date.now();
    const elapsed = now - this.lastRefill;
    this.tokens = Math.min(this.maxTokens, this.tokens + elapsed * this.refillRate);
    this.lastRefill = now;
  }
}
