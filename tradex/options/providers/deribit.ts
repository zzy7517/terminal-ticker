/**
 * Deribit Options Data Provider
 *
 * Uses the Deribit PUBLIC API to fetch BTC/ETH options data.
 * Completely free, no API key required, no registration needed.
 *
 * Deribit is the dominant crypto options exchange (~80%+ of BTC options volume).
 * Their public endpoints provide:
 *   - Full options chains with OI, volume, bid/ask, mark price
 *   - Greeks (delta, gamma, vega, theta) — computed by Deribit
 *   - IV
 *   - Real-time data
 *
 * API Docs: https://docs.deribit.com/
 */

import type { OptionChain, OptionQuote } from "../domain.js";
import { type OptionsDataProvider, RateLimiter } from "./base.js";

const DERIBIT_BASE_URL = "https://www.deribit.com/api/v2/public";

interface DeribitInstrument {
  instrument_name: string;
  kind: string;
  base_currency: string;
  strike: number;
  expiration_timestamp: number;
  option_type: "call" | "put";
  is_active: boolean;
}

interface DeribitBookSummary {
  instrument_name: string;
  underlying_price: number;
  mark_price: number;
  bid_price: number | null;
  ask_price: number | null;
  open_interest: number;
  volume: number;
  mark_iv: number;       // Mark IV as percentage (e.g., 55.5 = 55.5%)
  // Greeks
  greeks?: {
    delta: number;
    gamma: number;
    vega: number;
    theta: number;
  };
}

interface DeribitTickerResult {
  instrument_name: string;
  underlying_price: number;
  mark_price: number;
  best_bid_price: number | null;
  best_ask_price: number | null;
  open_interest: number;
  greeks: {
    delta: number;
    gamma: number;
    vega: number;
    theta: number;
    rho: number;
  };
  mark_iv: number;
  bid_iv: number;
  ask_iv: number;
}

export class DeribitProvider implements OptionsDataProvider {
  readonly name = "deribit";
  readonly providesGreeks = true;
  readonly rateLimit = 60;

  private readonly rateLimiter: RateLimiter;
  private readonly currencies: string[];

  constructor(currencies: string[] = ["BTC", "ETH"]) {
    this.rateLimiter = new RateLimiter(60);
    this.currencies = currencies;
  }

  async getSpotPrice(symbol: string): Promise<number> {
    await this.rateLimiter.acquire();

    // symbol = "BTC" or "ETH"
    const currency = symbol.toUpperCase();
    const indexName = `${currency.toLowerCase()}_usd`;

    const url = `${DERIBIT_BASE_URL}/get_index_price?index_name=${indexName}`;
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`Deribit index price failed for ${currency}: ${resp.status}`);

    const data = await resp.json() as { result?: { index_price?: number } };
    const price = data?.result?.index_price;
    if (price == null) throw new Error(`No index price for ${currency}`);
    return price;
  }

  async getExpirations(symbol: string): Promise<string[]> {
    await this.rateLimiter.acquire();

    const currency = symbol.toUpperCase();
    const url = `${DERIBIT_BASE_URL}/get_instruments?currency=${currency}&kind=option&expired=false`;
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`Deribit instruments failed for ${currency}: ${resp.status}`);

    const data = await resp.json() as { result?: DeribitInstrument[] };
    const instruments = data?.result ?? [];

    // Extract unique expiration dates
    const expirations = new Set<string>();
    for (const inst of instruments) {
      if (inst.is_active) {
        const expDate = new Date(inst.expiration_timestamp).toISOString().split("T")[0];
        expirations.add(expDate);
      }
    }

    return Array.from(expirations).sort();
  }

  async getOptionsChain(symbol: string, options?: {
    expiration?: string;
    strikeRangePercent?: number;
  }): Promise<OptionChain> {
    const currency = symbol.toUpperCase();

    // Get spot price
    const spotPrice = await this.getSpotPrice(currency);

    // Get all option book summaries for this currency
    await this.rateLimiter.acquire();
    const url = `${DERIBIT_BASE_URL}/get_book_summary_by_currency?currency=${currency}&kind=option`;
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`Deribit book summary failed for ${currency}: ${resp.status}`);

    const data = await resp.json() as { result?: DeribitBookSummary[] };
    const summaries = data?.result ?? [];

    if (summaries.length === 0) {
      return {
        underlying: currency,
        spotPrice,
        expiration: options?.expiration ?? "",
        contracts: [],
        timestamp: Date.now(),
        provider: this.name,
      };
    }

    // Filter by expiration if specified
    const rangePercent = options?.strikeRangePercent ?? 0.20;
    const minStrike = spotPrice * (1 - rangePercent);
    const maxStrike = spotPrice * (1 + rangePercent);

    const contracts: OptionQuote[] = [];
    let targetExpiration = options?.expiration ?? "";

    for (const summary of summaries) {
      const parsed = this.parseInstrumentName(summary.instrument_name);
      if (!parsed) continue;

      // Filter by expiration
      if (options?.expiration && parsed.expiration !== options.expiration) continue;

      // Filter by strike range
      if (parsed.strike < minStrike || parsed.strike > maxStrike) continue;

      // If no expiration filter, pick the nearest one
      if (!targetExpiration && parsed.expiration) {
        targetExpiration = parsed.expiration;
      }
      if (targetExpiration && parsed.expiration !== targetExpiration && !options?.expiration) {
        // Only include the nearest expiration when no explicit filter
        continue;
      }

      const quote = this.summaryToQuote(summary, parsed, currency, spotPrice);
      if (quote) contracts.push(quote);
    }

    return {
      underlying: currency,
      spotPrice,
      expiration: targetExpiration,
      contracts,
      timestamp: Date.now(),
      provider: this.name,
    };
  }

  /**
   * Get detailed ticker with Greeks for specific instruments.
   * Use this when you need accurate per-contract Greeks.
   */
  async getTicker(instrumentName: string): Promise<DeribitTickerResult | null> {
    await this.rateLimiter.acquire();

    const url = `${DERIBIT_BASE_URL}/ticker?instrument_name=${encodeURIComponent(instrumentName)}`;
    const resp = await fetch(url);
    if (!resp.ok) return null;

    const data = await resp.json() as { result?: DeribitTickerResult };
    return data?.result ?? null;
  }

  async close(): Promise<void> {
    // No persistent connections
  }

  // --------------------------------------------------------------------------
  // Private helpers
  // --------------------------------------------------------------------------

  private parseInstrumentName(name: string): {
    currency: string;
    expiration: string;
    strike: number;
    type: "call" | "put";
  } | null {
    // Format: BTC-28JUN26-120000-C
    const parts = name.split("-");
    if (parts.length !== 4) return null;

    const currency = parts[0];
    const expStr = parts[1];
    const strike = parseInt(parts[2], 10);
    const typeChar = parts[3];

    if (isNaN(strike)) return null;
    const type: "call" | "put" = typeChar === "C" ? "call" : "put";

    // Parse expiration: "28JUN26" -> "2026-06-28"
    const expiration = this.parseDeribitExpiration(expStr);
    if (!expiration) return null;

    return { currency, expiration, strike, type };
  }

  private parseDeribitExpiration(exp: string): string | null {
    // Format: "28JUN26" or "28JUN2026"
    const months: Record<string, string> = {
      JAN: "01", FEB: "02", MAR: "03", APR: "04",
      MAY: "05", JUN: "06", JUL: "07", AUG: "08",
      SEP: "09", OCT: "10", NOV: "11", DEC: "12",
    };

    const match = exp.match(/^(\d{1,2})([A-Z]{3})(\d{2,4})$/);
    if (!match) return null;

    const day = match[1].padStart(2, "0");
    const month = months[match[2]];
    let year = match[3];

    if (!month) return null;
    if (year.length === 2) year = "20" + year;

    return `${year}-${month}-${day}`;
  }

  private summaryToQuote(
    summary: DeribitBookSummary,
    parsed: { expiration: string; strike: number; type: "call" | "put" },
    currency: string,
    spotPrice: number,
  ): OptionQuote | null {
    // Deribit prices are in BTC/ETH, convert to USD
    const bidUsd = (summary.bid_price ?? 0) * spotPrice;
    const askUsd = (summary.ask_price ?? 0) * spotPrice;
    const midUsd = (summary.mark_price ?? 0) * spotPrice;

    // IV from Deribit is in percentage (55.5 = 55.5%), convert to decimal
    const iv = summary.mark_iv > 0 ? summary.mark_iv / 100 : null;

    return {
      symbol: summary.instrument_name,
      underlying: currency,
      strike: parsed.strike,
      expiration: parsed.expiration,
      type: parsed.type,
      bid: bidUsd,
      ask: askUsd,
      mid: midUsd,
      openInterest: summary.open_interest,
      volume: summary.volume,
      impliedVol: iv,
      // Deribit provides Greeks via the ticker endpoint, but book_summary doesn't
      // include them. For GEX calculation we only need OI + Gamma which we compute.
      delta: summary.greeks?.delta ?? null,
      gamma: summary.greeks?.gamma ?? null,
      vega: summary.greeks?.vega ?? null,
      theta: summary.greeks?.theta ?? null,
    };
  }
}
