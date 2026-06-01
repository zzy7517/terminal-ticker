/**
 * Tradier Options Data Provider
 *
 * Uses the Tradier brokerage market-data API to fetch options chains.
 * Unlike Yahoo Finance, Tradier:
 *   - Covers INDEX options (SPX, NDX, VIX, RUT) in addition to stocks/ETFs
 *   - Returns full Greeks (delta/gamma/theta/vega) and IV directly (courtesy
 *     of ORATS) when `greeks=true`, so no local Black-Scholes calc is needed
 *
 * Access:
 *   - Free with a Tradier developer / paper-trading account.
 *   - Sandbox base URL gives delayed data; production base URL with a funded
 *     brokerage token gives real-time. Default is sandbox.
 *
 * Config (watchlist.toml):
 *   [options]
 *   provider = "tradier"
 *   [options.tradier]
 *   api_key  = "..."                              # required
 *   base_url = "https://sandbox.tradier.com/v1"   # optional, this is the default
 *
 * Docs: https://documentation.tradier.com/brokerage-api/markets/get-options-chains
 */

import type { OptionChain, OptionQuote } from "../domain.js";
import { type OptionsDataProvider, RateLimiter } from "./base.js";

const DEFAULT_BASE_URL = "https://sandbox.tradier.com/v1";

/** Tradier returns either a single object or an array for list fields. */
type OneOrMany<T> = T | T[] | null | undefined;

interface TradierGreeks {
  delta?: number;
  gamma?: number;
  theta?: number;
  vega?: number;
  rho?: number;
  bid_iv?: number;
  mid_iv?: number;
  ask_iv?: number;
  smv_vol?: number;
}

interface TradierOption {
  symbol?: string;
  underlying?: string;
  strike?: number;
  bid?: number;
  ask?: number;
  last?: number;
  open_interest?: number;
  volume?: number;
  option_type?: "call" | "put";
  expiration_date?: string; // "YYYY-MM-DD"
  greeks?: TradierGreeks;
}

interface TradierChainResponse {
  options?: { option?: OneOrMany<TradierOption> } | null;
}

interface TradierExpirationsResponse {
  expirations?: { date?: OneOrMany<string> } | null;
}

interface TradierQuotesResponse {
  quotes?: { quote?: OneOrMany<{ symbol?: string; last?: number; close?: number; prevclose?: number }> } | null;
}

/** Normalize Tradier's single-or-array shape into a plain array. */
function toArray<T>(value: OneOrMany<T>): T[] {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

export class TradierProvider implements OptionsDataProvider {
  readonly name = "tradier";
  readonly providesGreeks = true;
  readonly rateLimit = 60; // Tradier allows ~120/min; stay conservative

  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly rateLimiter: RateLimiter;

  constructor(apiKey: string, baseUrl = DEFAULT_BASE_URL, callsPerMinute = 60) {
    if (!apiKey) {
      throw new Error("TradierProvider requires an API key");
    }
    this.apiKey = apiKey;
    // Strip a trailing slash so we can join paths cleanly.
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.rateLimiter = new RateLimiter(callsPerMinute);
  }

  async getSpotPrice(symbol: string): Promise<number> {
    await this.rateLimiter.acquire();

    // Index symbols are quoted with a leading "$" and ".X" suffix on Tradier
    // (e.g. SPX -> $SPX.X). Try the raw symbol first, then the index form.
    const candidates = this.quoteSymbolCandidates(symbol);

    for (const candidate of candidates) {
      const url = `${this.baseUrl}/markets/quotes?symbols=${encodeURIComponent(candidate)}`;
      const data = await this.fetchJson<TradierQuotesResponse>(url, `quote for ${symbol}`);
      const quotes = toArray(data?.quotes?.quote);
      const price = quotes[0]?.last ?? quotes[0]?.close ?? quotes[0]?.prevclose;
      if (price != null && price > 0) return price;
    }

    throw new Error(`No price data for ${symbol} from Tradier`);
  }

  async getExpirations(symbol: string): Promise<string[]> {
    await this.rateLimiter.acquire();

    const url = `${this.baseUrl}/markets/options/expirations?symbol=${encodeURIComponent(symbol)}&includeAllRoots=true`;
    const data = await this.fetchJson<TradierExpirationsResponse>(url, `expirations for ${symbol}`);
    return toArray(data?.expirations?.date);
  }

  async getOptionsChain(symbol: string, options?: {
    expiration?: string;
    strikeRangePercent?: number;
  }): Promise<OptionChain> {
    // Resolve expiration (nearest if not supplied) and spot in parallel.
    const [expiration, spotPrice] = await Promise.all([
      options?.expiration
        ? Promise.resolve(options.expiration)
        : this.getExpirations(symbol).then((dates) => dates[0] ?? ""),
      this.getSpotPrice(symbol).catch(() => 0),
    ]);

    if (!expiration) {
      return this.emptyChain(symbol, "", spotPrice);
    }

    await this.rateLimiter.acquire();
    const url = `${this.baseUrl}/markets/options/chains`
      + `?symbol=${encodeURIComponent(symbol)}`
      + `&expiration=${encodeURIComponent(expiration)}`
      + `&greeks=true`;

    const data = await this.fetchJson<TradierChainResponse>(url, `options chain for ${symbol}`);
    const rawContracts = toArray(data?.options?.option);

    if (rawContracts.length === 0) {
      return this.emptyChain(symbol, expiration, spotPrice);
    }

    // If the quote endpoint failed, fall back to the ATM strike as a spot proxy.
    const effectiveSpot = spotPrice > 0 ? spotPrice : this.inferSpotFromStrikes(rawContracts);

    const rangePercent = options?.strikeRangePercent ?? 0.15;
    const minStrike = effectiveSpot * (1 - rangePercent);
    const maxStrike = effectiveSpot * (1 + rangePercent);

    const contracts: OptionQuote[] = [];
    for (const raw of rawContracts) {
      const quote = this.parseOption(raw, symbol, expiration);
      if (!quote) continue;
      // Only range-filter when we have a usable spot price.
      if (effectiveSpot > 0 && (quote.strike < minStrike || quote.strike > maxStrike)) continue;
      contracts.push(quote);
    }

    return {
      underlying: symbol,
      spotPrice: effectiveSpot,
      expiration,
      contracts,
      timestamp: Date.now(),
      provider: this.name,
    };
  }

  async close(): Promise<void> {
    // No persistent connections to close.
  }

  // --------------------------------------------------------------------------
  // Private helpers
  // --------------------------------------------------------------------------

  private async fetchJson<T>(url: string, context: string): Promise<T> {
    const resp = await fetch(url, {
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        Accept: "application/json",
      },
    });

    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      throw new Error(`Tradier ${context} failed: ${resp.status}${body ? ` — ${body.slice(0, 200)}` : ""}`);
    }

    return (await resp.json()) as T;
  }

  private parseOption(raw: TradierOption, underlying: string, expiration: string): OptionQuote | null {
    const strike = raw.strike;
    if (!strike || strike <= 0) return null;
    if (raw.option_type !== "call" && raw.option_type !== "put") return null;

    const bid = raw.bid ?? 0;
    const ask = raw.ask ?? 0;
    const g = raw.greeks;
    const iv = g?.mid_iv ?? g?.smv_vol ?? null;

    return {
      symbol: raw.symbol ?? `${underlying}_${raw.option_type}_${strike}`,
      underlying,
      strike,
      expiration: raw.expiration_date ?? expiration,
      type: raw.option_type,
      bid,
      ask,
      mid: bid > 0 && ask > 0 ? (bid + ask) / 2 : raw.last ?? 0,
      openInterest: raw.open_interest ?? 0,
      volume: raw.volume ?? 0,
      impliedVol: iv != null && iv > 0 ? iv : null,
      // Tradier supplies Greeks directly (ORATS). Null when greeks unavailable
      // (e.g. just-listed contracts) — the GEX calculator fills those locally.
      delta: g?.delta ?? null,
      gamma: g?.gamma ?? null,
      vega: g?.vega ?? null,
      theta: g?.theta ?? null,
    };
  }

  /** Candidate symbols for the quote endpoint (handles index "$SPX.X" form). */
  private quoteSymbolCandidates(symbol: string): string[] {
    const upper = symbol.toUpperCase();
    if (upper.startsWith("$")) return [upper];
    const INDEX_SYMBOLS = new Set(["SPX", "NDX", "VIX", "RUT", "DJX", "XSP"]);
    if (INDEX_SYMBOLS.has(upper)) {
      return [upper, `$${upper}.X`];
    }
    return [symbol];
  }

  /**
   * Estimate spot from the chain when the quote endpoint is unavailable:
   * the strike where |call mid - put mid| is smallest is approximately ATM
   * (put-call parity), so that strike is a reasonable spot proxy. Falls back
   * to the median strike.
   */
  private inferSpotFromStrikes(contracts: TradierOption[]): number {
    const callsByStrike = new Map<number, number>();
    const putsByStrike = new Map<number, number>();
    const strikes = new Set<number>();

    for (const c of contracts) {
      const strike = c.strike;
      if (!strike || strike <= 0) continue;
      strikes.add(strike);
      const mid = (c.bid ?? 0) > 0 && (c.ask ?? 0) > 0 ? (c.bid! + c.ask!) / 2 : (c.last ?? 0);
      if (c.option_type === "call") callsByStrike.set(strike, mid);
      else if (c.option_type === "put") putsByStrike.set(strike, mid);
    }

    let bestStrike = 0;
    let bestDiff = Infinity;
    for (const strike of strikes) {
      const call = callsByStrike.get(strike);
      const put = putsByStrike.get(strike);
      if (call == null || put == null) continue;
      const diff = Math.abs(call - put);
      if (diff < bestDiff) {
        bestDiff = diff;
        bestStrike = strike;
      }
    }

    if (bestStrike > 0) return bestStrike;

    // Fallback: median strike.
    const sorted = [...strikes].sort((a, b) => a - b);
    return sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0;
  }

  private emptyChain(symbol: string, expiration: string, spotPrice: number): OptionChain {
    return {
      underlying: symbol,
      spotPrice: spotPrice || 0,
      expiration,
      contracts: [],
      timestamp: Date.now(),
      provider: this.name,
    };
  }
}