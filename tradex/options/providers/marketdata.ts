/**
 * MarketData.app Options Data Provider
 *
 * Free, no-approval fallback source for US equity/ETF option chains. Unlike
 * Yahoo Finance it:
 *   - Issues an API token instantly (no brokerage account / approval wait)
 *   - Returns full Greeks (delta/gamma/theta/vega) and IV directly, so no local
 *     Black-Scholes calc is needed
 *
 * Access:
 *   - Free "Free Forever" plan: 100 credits/day, options data delayed ~24h.
 *     Plenty for a low-frequency (e.g. twice-daily) structural GEX read.
 *   - Token is sent as a Bearer header.
 *
 * Credit-cost note:
 *   The chain endpoint bills 1 credit per option symbol returned (with prices).
 *   To stay cheap we request a SINGLE near-term expiration via `dte` and cap the
 *   number of strikes with `strikeLimit` — never `expiration=all`, which on SPY/
 *   QQQ returns thousands of contracts and burns credits fast.
 *
 * Config (watchlist.toml):
 *   [options.marketdata]
 *   api_key = "..."                                  # required to enable
 *   base_url = "https://api.marketdata.app/v1"       # optional, this is default
 *
 * Docs: https://www.marketdata.app/docs/api/options/chain/
 */

import type { OptionChain, OptionQuote } from "../domain.js";
import { type OptionsDataProvider, RateLimiter } from "./base.js";

const DEFAULT_BASE_URL = "https://api.marketdata.app/v1";

/**
 * MarketData.app returns column-oriented arrays: every field is an array and
 * the i-th element across all arrays describes one contract. `s` is the status
 * ("ok" | "no_data" | "error").
 */
interface MarketDataChainResponse {
  s: string;
  errmsg?: string;
  optionSymbol?: string[];
  underlying?: string[];
  expiration?: number[]; // unix seconds
  side?: string[]; // "call" | "put"
  strike?: number[];
  bid?: number[];
  ask?: number[];
  mid?: number[];
  last?: number[];
  openInterest?: number[];
  volume?: number[];
  underlyingPrice?: number[];
  iv?: (number | null)[];
  delta?: (number | null)[];
  gamma?: (number | null)[];
  theta?: (number | null)[];
  vega?: (number | null)[];
}

/** Convert a unix-seconds timestamp to a "YYYY-MM-DD" expiration string. */
function unixToDate(seconds: number): string {
  return new Date(seconds * 1000).toISOString().slice(0, 10);
}

export class MarketDataProvider implements OptionsDataProvider {
  readonly name = "marketdata";
  readonly providesGreeks = true;
  readonly rateLimit = 30; // Conservative; free plan is credit- not rate-bound.

  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly rateLimiter: RateLimiter;

  /** Near-term expiration to target (days-to-expiry). */
  private readonly dte: number;
  /** Max strikes returned (per side after range filtering), to cap credits. */
  private readonly strikeLimit: number;

  constructor(
    apiKey: string,
    baseUrl = DEFAULT_BASE_URL,
    callsPerMinute = 30,
    opts?: { dte?: number; strikeLimit?: number },
  ) {
    if (!apiKey) throw new Error("MarketDataProvider requires an API key");
    this.apiKey = apiKey;
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.rateLimiter = new RateLimiter(callsPerMinute);
    this.dte = opts?.dte ?? 7;
    this.strikeLimit = opts?.strikeLimit ?? 80;
  }

  async getSpotPrice(symbol: string): Promise<number> {
    // The chain response carries underlyingPrice, so we avoid a separate quote
    // call (saves credits). Fetch the chain and read the first underlyingPrice.
    const chain = await this.getOptionsChain(symbol);
    return chain.spotPrice;
  }

  async getExpirations(symbol: string): Promise<string[]> {
    await this.rateLimiter.acquire();
    const url = `${this.baseUrl}/options/expirations/${encodeURIComponent(symbol)}/`;
    const data = await this.fetchJson<{ s: string; expirations?: string[] }>(url, `expirations for ${symbol}`);
    return data.expirations ?? [];
  }

  async getOptionsChain(symbol: string, options?: {
    expiration?: string;
    strikeRangePercent?: number;
  }): Promise<OptionChain> {
    await this.rateLimiter.acquire();

    // Target a single near-term expiration and cap strikes to keep credit use
    // low (1 credit per returned contract). When an explicit expiration is
    // requested we honour it; otherwise `dte` selects the closest expiration.
    const params = new URLSearchParams();
    if (options?.expiration) {
      params.set("expiration", options.expiration);
    } else {
      params.set("dte", String(this.dte));
    }
    params.set("strikeLimit", String(this.strikeLimit));
    // Trim columns to what GEX needs; fewer quote columns = fewer credits.
    params.set(
      "columns",
      "optionSymbol,underlying,expiration,side,strike,bid,ask,mid,last,openInterest,volume,underlyingPrice,iv,delta,gamma,theta,vega",
    );

    const url = `${this.baseUrl}/options/chain/${encodeURIComponent(symbol)}/?${params.toString()}`;
    const data = await this.fetchJson<MarketDataChainResponse>(url, `options chain for ${symbol}`);

    // Delayed responses (HTTP 203) may omit the `s` field; treat presence of
    // strike data as success. Only an explicit error/no_data is non-fatal-empty.
    if (data.s === "error") {
      throw new Error(`MarketData chain for ${symbol}: ${data.errmsg ?? "error"}`);
    }
    if (data.s === "no_data" || !data.strike || data.strike.length === 0) {
      return this.emptyChain(symbol, options?.expiration ?? "");
    }

    const count = data.strike.length;
    const spotPrice = data.underlyingPrice?.[0] ?? 0;
    const rangePercent = options?.strikeRangePercent ?? 0.15;
    const minStrike = spotPrice > 0 ? spotPrice * (1 - rangePercent) : -Infinity;
    const maxStrike = spotPrice > 0 ? spotPrice * (1 + rangePercent) : Infinity;

    let expiration = options?.expiration ?? "";
    const contracts: OptionQuote[] = [];
    for (let i = 0; i < count; i++) {
      const strike = data.strike[i];
      const side = data.side?.[i];
      if (!strike || strike <= 0) continue;
      if (side !== "call" && side !== "put") continue;
      if (strike < minStrike || strike > maxStrike) continue;

      const exp = data.expiration?.[i] != null ? unixToDate(data.expiration[i]) : expiration;
      if (!expiration) expiration = exp;

      const bid = data.bid?.[i] ?? 0;
      const ask = data.ask?.[i] ?? 0;
      const iv = data.iv?.[i];

      contracts.push({
        symbol: data.optionSymbol?.[i] ?? `${symbol}_${side}_${strike}`,
        underlying: symbol,
        strike,
        expiration: exp,
        type: side,
        bid,
        ask,
        mid: data.mid?.[i] ?? (bid > 0 && ask > 0 ? (bid + ask) / 2 : data.last?.[i] ?? 0),
        openInterest: data.openInterest?.[i] ?? 0,
        volume: data.volume?.[i] ?? 0,
        impliedVol: iv != null && iv > 0 ? iv : null,
        // Greeks supplied directly; null entries fall back to local calc.
        delta: data.delta?.[i] ?? null,
        gamma: data.gamma?.[i] ?? null,
        vega: data.vega?.[i] ?? null,
        theta: data.theta?.[i] ?? null,
      });
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
    // No persistent connections.
  }

  // --------------------------------------------------------------------------
  // Private helpers
  // --------------------------------------------------------------------------

  private async fetchJson<T>(url: string, context: string): Promise<T> {
    // Retry transient network errors (e.g. proxy hiccups, connection resets)
    // once before letting the fallback chain downgrade to a backup provider —
    // MarketData data quality (full Greeks) is worth a quick second attempt.
    let resp: Response;
    let lastNetworkErr: unknown = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        resp = await fetch(url, {
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            Accept: "application/json",
          },
        });
        lastNetworkErr = null;
        break;
      } catch (err) {
        lastNetworkErr = err;
        if (attempt === 0) await new Promise((r) => setTimeout(r, 500));
      }
    }
    if (lastNetworkErr) {
      throw new Error(`MarketData ${context} network error: ${lastNetworkErr instanceof Error ? lastNetworkErr.message : String(lastNetworkErr)}`);
    }
    resp = resp!;

    // 203 = delayed/cached data on the free plan; still a successful body.
    if (!resp.ok && resp.status !== 203) {
      const body = await resp.text().catch(() => "");
      const hint =
        resp.status === 402 || resp.status === 429
          ? " (out of credits or rate-limited)"
          : "";
      throw new Error(`MarketData ${context} failed: ${resp.status}${hint}${body ? ` — ${body.slice(0, 200)}` : ""}`);
    }

    return (await resp.json()) as T;
  }

  private emptyChain(symbol: string, expiration: string): OptionChain {
    return {
      underlying: symbol,
      spotPrice: 0,
      expiration,
      contracts: [],
      timestamp: Date.now(),
      provider: this.name,
    };
  }
}
