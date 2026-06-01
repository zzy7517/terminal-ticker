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
 * - Requires crumb + cookie authentication (auto-fetched and cached)
 * - Provides IV but NOT other Greeks (calculated locally)
 * - May be rate-limited by Yahoo (recommend ≥60s poll interval)
 */

import type { OptionChain, OptionQuote } from "../domain.js";
import { type OptionsDataProvider, RateLimiter } from "./base.js";

const YAHOO_OPTIONS_URL = "https://query2.finance.yahoo.com/v7/finance/options";
const YAHOO_QUOTE_URL = "https://query2.finance.yahoo.com/v7/finance/quote";
const YAHOO_CRUMB_URL = "https://query2.finance.yahoo.com/v1/test/getcrumb";
const YAHOO_COOKIE_URL = "https://fc.yahoo.com";

/** Crumb + cookie session, refreshed when stale or on 401. */
interface YahooSession {
  cookie: string;
  crumb: string;
  obtainedAt: number;
}

/** Session is valid for 1 hour before proactive refresh. */
const SESSION_TTL_MS = 60 * 60 * 1000;

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
  private session: YahooSession | null = null;

  constructor(callsPerMinute = 30) {
    this.rateLimiter = new RateLimiter(callsPerMinute);
  }

  async getSpotPrice(symbol: string): Promise<number> {
    await this.rateLimiter.acquire();

    const url = `${YAHOO_QUOTE_URL}?symbols=${encodeURIComponent(symbol)}`;
    const resp = await this.authenticatedFetch(url);

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
    const resp = await this.authenticatedFetch(url);

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
    const params: string[] = [];
    if (options?.expiration) {
      const expTimestamp = Math.floor(new Date(options.expiration + "T16:00:00Z").getTime() / 1000);
      params.push(`date=${expTimestamp}`);
    }

    const resp = await this.authenticatedFetch(url, params);
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
  // Authentication — crumb + cookie
  // --------------------------------------------------------------------------

  /**
   * Fetch with crumb/cookie auth. On 401, refreshes the session once and retries.
   */
  private async authenticatedFetch(baseUrl: string, extraParams: string[] = []): Promise<Response> {
    const session = await this.ensureSession();
    const url = this.buildUrl(baseUrl, session.crumb, extraParams);

    const resp = await fetch(url, { headers: this.headersWithCookie(session) });

    if (resp.status === 401) {
      // Session expired — refresh and retry once
      console.log("[options/yfinance] Crumb expired, refreshing session...");
      this.session = null;
      const freshSession = await this.ensureSession();
      const retryUrl = this.buildUrl(baseUrl, freshSession.crumb, extraParams);
      return fetch(retryUrl, { headers: this.headersWithCookie(freshSession) });
    }

    return resp;
  }

  private buildUrl(baseUrl: string, crumb: string, extraParams: string[]): string {
    const params = [`crumb=${encodeURIComponent(crumb)}`, ...extraParams];
    const separator = baseUrl.includes("?") ? "&" : "?";
    return `${baseUrl}${separator}${params.join("&")}`;
  }

  private async ensureSession(): Promise<YahooSession> {
    if (this.session && Date.now() - this.session.obtainedAt < SESSION_TTL_MS) {
      return this.session;
    }

    console.log("[options/yfinance] Obtaining crumb + cookie session...");

    // Step 1: Get cookie from fc.yahoo.com
    const cookieResp = await fetch(YAHOO_COOKIE_URL, { redirect: "manual" });
    const setCookies = cookieResp.headers.getSetCookie?.() ?? [];
    const cookie = setCookies.map(c => c.split(";")[0]).join("; ");

    if (!cookie) {
      throw new Error("Yahoo Finance: failed to obtain session cookie");
    }

    // Step 2: Get crumb using the cookie
    const crumbResp = await fetch(YAHOO_CRUMB_URL, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
        "Cookie": cookie,
      },
    });

    if (!crumbResp.ok) {
      throw new Error(`Yahoo Finance: crumb request failed with ${crumbResp.status}`);
    }

    const crumb = await crumbResp.text();
    if (!crumb || crumb.includes("<")) {
      throw new Error("Yahoo Finance: invalid crumb response (possibly blocked)");
    }

    this.session = { cookie, crumb, obtainedAt: Date.now() };
    console.log("[options/yfinance] Session established successfully.");
    return this.session;
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

  private headersWithCookie(session: YahooSession): Record<string, string> {
    return {
      "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
      "Accept": "application/json",
      "Cookie": session.cookie,
    };
  }
}
