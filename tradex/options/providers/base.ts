/**
 * Options Data Provider - Base Interface
 *
 * All providers must implement this interface. Providers fetch options chain data
 * from external sources and return normalized OptionChain objects.
 */

import type { OptionChain } from "../domain.js";

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

  constructor(callsPerMinute: number) {
    this.maxTokens = callsPerMinute;
    this.tokens = callsPerMinute;
    this.lastRefill = Date.now();
    this.refillRate = callsPerMinute / 60_000;
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
