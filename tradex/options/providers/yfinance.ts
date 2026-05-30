/**
 * Yahoo Finance Options Data Provider
 *
 * Uses the public Yahoo Finance API (v7/finance/options endpoint) to fetch
 * options chain data for any US stock or ETF. No API key required.
 *
 * Supported: SPY, QQQ, AAPL, NVDA, TSLA, MSFT, GLD, IBIT, etc.
 * NOT supported: Index options (SPX, NDX) — Yahoo doesn't carry them.
 *
 * Key characteristics:
 * - Free, no API key
 * - Provides IV but NOT other Greeks (calculated locally)
 * - May be rate-limited by Yahoo (recommend ≥60s poll interval)
 */

import type { OptionChain, OptionQuote } from "../domain.js";
import { type OptionsDataProvider, RateLimiter } from "./base.js";

const YAHOO_OPTIONS_URL = "https://query2.finance.yahoo.com/v7/finance/options";
const YAHOO_QUOTE_URL = "https://query2.finance.yahoo.com/v7/finance/quote";

interface YahooOption {
  contractSymbol?: string;
  strike?: number;
  expiration?: number; // Unix timestamp
  bid?: number;
  ask?: number;
  lastPrice?: number;
  openInterest?: number;
  volume?: number;
  impliedVolatility?: number;
}

interface YahooOptionsResponse {
  optionChain?: {
    result?: Array<{
      quote?: {
        regularMarketPrice?: number;
        symbol?: string;
      };
      expirationDates?: number[];
      options?: Array<{
        expirationDate?: number;
        calls?: YahooOption[];
        puts?: YahooOption[];
      }>;
    }>;
  };
}

export class YFinanceProvider implements OptionsDataProvider {
  readonly name = "yfinance";
  readonly providesGreeks = false;
  readonly rateLimit = 30; // conservative

  private readonly rateLimiter: RateLimiter;

  constructor(callsPerMinute = 30) {
    this.rateLimiter = new RateLimiter(callsPerMinute);
  }

  async getSpotPrice(symbol: string): Promise<number> {
    await this.rateLimiter.acquire();

    const url = `${YAHOO_QUOTE_URL}?symbols=${encodeURIComponent(symbol)}`;
    const resp = await fetch(url, { headers: this.defaultHeaders() });

    if (!resp.ok) {
      throw new Error(`Yahoo Finance quote failed for ${symbol}: ${resp.status}`);
    }

    const data = await resp.json() as { quoteResponse?: { result?: Array<{ regularMarketPrice?: number }> } };
    const price = data?.quoteResponse?.result?.[0]?.regularMarketPrice;

    if (price == null) {
      throw new Error(`No price data for ${symbol} from Yahoo Finance`);
    }
    return price;
  }

  async getExpirations(symbol: string): Promise<string[]> {
    await this.rateLimiter.acquire();

    const url = `${YAHOO_OPTIONS_URL}/${encodeURIComponent(symbol)}`;
    const resp = await fetch(url, { headers: this.defaultHeaders() });

    if (!resp.ok) {
      throw new Error(`Yahoo Finance expirations failed for ${symbol}: ${resp.status}`);
    }

    const data = await resp.json() as YahooOptionsResponse;
    const timestamps = data?.optionChain?.result?.[0]?.expirationDates ?? [];

    return timestamps.map(ts => {
      const d = new Date(ts * 1000);
      return d.toISOString().split("T")[0];
    });
  }

  async getOptionsChain(symbol: string, options?: {
    expiration?: string;
    strikeRangePercent?: number;
  }): Promise<OptionChain> {
    await this.rateLimiter.acquire();

    // Build URL with optional expiration
    let url = `${YAHOO_OPTIONS_URL}/${encodeURIComponent(symbol)}`;
    if (options?.expiration) {
      const expTimestamp = Math.floor(new Date(options.expiration + "T16:00:00Z").getTime() / 1000);
      url += `?date=${expTimestamp}`;
    }

    const resp = await fetch(url, { headers: this.defaultHeaders() });
    if (!resp.ok) {
      throw new Error(`Yahoo Finance options chain failed for ${symbol}: ${resp.status}`);
    }

    const data = await resp.json() as YahooOptionsResponse;
    const result = data?.optionChain?.result?.[0];

    if (!result) {
      throw new Error(`No options data returned for ${symbol}`);
    }

    const spotPrice = result.quote?.regularMarketPrice ?? 0;
    const optionsData = result.options?.[0];

    if (!optionsData || spotPrice === 0) {
      return {
        underlying: symbol,
        spotPrice: spotPrice || 0,
        expiration: options?.expiration ?? "",
        contracts: [],
        timestamp: Date.now(),
        provider: this.name,
      };
    }

    const expiration = optionsData.expirationDate
      ? new Date(optionsData.expirationDate * 1000).toISOString().split("T")[0]
      : options?.expiration ?? "";

    // Parse calls and puts
    const contracts: OptionQuote[] = [];
    const rangePercent = options?.strikeRangePercent ?? 0.15;
    const minStrike = spotPrice * (1 - rangePercent);
    const maxStrike = spotPrice * (1 + rangePercent);

    for (const call of optionsData.calls ?? []) {
      const quote = this.parseYahooOption(call, symbol, expiration, "call");
      if (quote && quote.strike >= minStrike && quote.strike <= maxStrike) {
        contracts.push(quote);
      }
    }

    for (const put of optionsData.puts ?? []) {
      const quote = this.parseYahooOption(put, symbol, expiration, "put");
      if (quote && quote.strike >= minStrike && quote.strike <= maxStrike) {
        contracts.push(quote);
      }
    }

    return {
      underlying: symbol,
      spotPrice,
      expiration,
      contracts,
      timestamp: Date.now(),
      provider: this.name,
    };
  }

  async close(): Promise<void> {
    // No persistent connections to close
  }

  // --------------------------------------------------------------------------
  // Private helpers
  // --------------------------------------------------------------------------

  private parseYahooOption(
    raw: YahooOption,
    underlying: string,
    expiration: string,
    type: "call" | "put",
  ): OptionQuote | null {
    const strike = raw.strike;
    if (!strike || strike <= 0) return null;

    const bid = raw.bid ?? 0;
    const ask = raw.ask ?? 0;
    const oi = raw.openInterest ?? 0;
    const volume = raw.volume ?? 0;
    const iv = raw.impliedVolatility ?? null;

    return {
      symbol: raw.contractSymbol ?? `${underlying}_${type}_${strike}`,
      underlying,
      strike,
      expiration,
      type,
      bid,
      ask,
      mid: bid > 0 && ask > 0 ? (bid + ask) / 2 : raw.lastPrice ?? 0,
      openInterest: oi,
      volume,
      impliedVol: iv,
      // Greeks not provided by Yahoo Finance — will be calculated locally
      delta: null,
      gamma: null,
      vega: null,
      theta: null,
    };
  }

  private defaultHeaders(): Record<string, string> {
    return {
      "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
      "Accept": "application/json",
    };
  }
}
