/**
 * Quotes provider — the series FRED does not carry: ICE DXY, spot gold, spot
 * silver.
 *
 * Two backends behind one interface:
 *
 *  - Twelve Data — properly licensed, free tier is 800 requests/day. Preferred
 *    when a key is configured.
 *  - Yahoo Finance — unofficial chart endpoint, no key. Works today, but measured
 *    in 2026-07 it answers 403/429 from some regions regardless of user agent or
 *    crumb, so treat an empty series here as expected rather than broken. The
 *    project's outbound proxy is enough to get through.
 *
 * Nothing here is load-bearing. VIX, the FX pairs, WTI and natural gas all moved
 * to FRED, and the dollar has a keyless FRED fallback in `dxy_broad`
 * (DTWEXBGS, a broader basket than ICE DXY but the same signal).
 */

import type { MacroPoint } from "../domain.js";

const TWELVE_DATA_BASE = "https://api.twelvedata.com/time_series";
const YAHOO_BASE = "https://query1.finance.yahoo.com/v8/finance/chart";

export interface QuoteSeriesSpec {
  seriesId: string;
  /** Yahoo ticker, e.g. "^VIX". */
  yahooSymbol: string;
  /** Twelve Data ticker, e.g. "VIX". */
  twelveDataSymbol: string;
}

/**
 * Symbol mapping for the quote-sourced series.
 *
 * `^TNX` and `^VIX` are deliberately absent — the 10-year yield and VIX both come
 * from FRED (`us10y`, `vix`) with better provenance and no quota. Must stay in
 * sync with `QUOTES_SERIES` in registry.ts; `quotes.test.ts` asserts that.
 */
export const QUOTE_SERIES: QuoteSeriesSpec[] = [
  { seriesId: "dxy", yahooSymbol: "DX-Y.NYB", twelveDataSymbol: "DXY" },
  // Yahoo has no spot metal tickers (`XAUUSD=X` 404s), so the fallback uses the
  // COMEX front-month futures. Twelve Data does carry true spot, hence the
  // mismatched pair: front-month basis versus spot is a fraction of a percent
  // and both answer the same question at daily frequency.
  { seriesId: "gold", yahooSymbol: "GC=F", twelveDataSymbol: "XAU/USD" },
  { seriesId: "silver", yahooSymbol: "SI=F", twelveDataSymbol: "XAG/USD" },
];

interface YahooChartResponse {
  chart?: {
    result?: Array<{
      timestamp?: number[];
      indicators?: { quote?: Array<{ close?: Array<number | null> }> };
    }>;
    error?: { description?: string } | null;
  };
}

interface TwelveDataResponse {
  values?: Array<{ datetime?: string; close?: string }>;
  status?: string;
  message?: string;
}

export class IndexQuotesProvider {
  readonly name: "twelvedata" | "yahoo";
  private readonly twelveDataKey: string;

  constructor(twelveDataApiKey: string) {
    this.twelveDataKey = twelveDataApiKey.trim();
    this.name = this.twelveDataKey ? "twelvedata" : "yahoo";
  }

  /** Always usable — Yahoo needs no key. */
  readonly available = true;

  /** True when running on the licensed backend. */
  get licensed(): boolean {
    return this.twelveDataKey.length > 0;
  }

  /**
   * Fetch daily closes for one index.
   *
   * Daily bars, not intraday: these series feed environment context, and a
   * daily close keeps us far inside Twelve Data's 800/day budget. Values are
   * real-time in the revision sense, so `vintageTs` is null.
   */
  async fetchQuotes(spec: QuoteSeriesSpec, days: number): Promise<MacroPoint[]> {
    if (this.twelveDataKey) {
      return this.fetchFromTwelveData(spec, days);
    }
    return this.fetchFromYahoo(spec, days);
  }

  // ── Twelve Data ─────────────────────────────────────────────────────────────

  private async fetchFromTwelveData(spec: QuoteSeriesSpec, days: number): Promise<MacroPoint[]> {
    const params = new URLSearchParams({
      symbol: spec.twelveDataSymbol,
      interval: "1day",
      outputsize: String(Math.min(Math.max(days, 1), 5000)),
      apikey: this.twelveDataKey,
    });

    const response = await fetch(`${TWELVE_DATA_BASE}?${params.toString()}`);
    const payload = (await response.json().catch(() => null)) as TwelveDataResponse | null;

    // Twelve Data reports errors in the body with HTTP 200.
    if (!response.ok || payload?.status === "error") {
      const detail = payload?.message ?? response.statusText;
      throw new Error(`Twelve Data ${spec.twelveDataSymbol} failed: ${detail}`);
    }

    const points: MacroPoint[] = [];
    for (const row of payload?.values ?? []) {
      const ts = parseDayUtc(row.datetime);
      if (ts === null) continue;
      const close = Number(row.close);
      points.push({
        seriesId: spec.seriesId,
        ts,
        value: Number.isFinite(close) ? close : null,
        vintageTs: null,
      });
    }
    return points;
  }

  // ── Yahoo ───────────────────────────────────────────────────────────────────

  private async fetchFromYahoo(spec: QuoteSeriesSpec, days: number): Promise<MacroPoint[]> {
    const range = days <= 5 ? "5d" : days <= 30 ? "1mo" : days <= 90 ? "3mo" : days <= 365 ? "1y" : "5y";
    const url = `${YAHOO_BASE}/${encodeURIComponent(spec.yahooSymbol)}?interval=1d&range=${range}`;

    // A browser-ish UA avoids Yahoo's bot rejection on the unofficial endpoint.
    const response = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0", Accept: "application/json" },
    });
    if (!response.ok) {
      throw new Error(`Yahoo ${spec.yahooSymbol} failed: ${response.status} ${response.statusText}`);
    }

    const payload = (await response.json()) as YahooChartResponse;
    if (payload.chart?.error) {
      throw new Error(`Yahoo ${spec.yahooSymbol} failed: ${payload.chart.error.description ?? "unknown"}`);
    }

    const result = payload.chart?.result?.[0];
    const timestamps = result?.timestamp ?? [];
    const closes = result?.indicators?.quote?.[0]?.close ?? [];

    const points: MacroPoint[] = [];
    for (let i = 0; i < timestamps.length; i++) {
      const seconds = timestamps[i];
      if (!Number.isFinite(seconds)) continue;
      const close = closes[i];
      points.push({
        seriesId: spec.seriesId,
        // Normalise to UTC midnight so a daily bar has one canonical timestamp
        // regardless of the exchange's session close.
        ts: floorToUtcDay(seconds * 1000),
        value: typeof close === "number" && Number.isFinite(close) ? cleanFloat(close) : null,
        vintageTs: null,
      });
    }
    return points;
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function parseDayUtc(datetime: string | undefined): number | null {
  if (!datetime) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(datetime.trim());
  if (!match) return null;
  const ms = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return Number.isFinite(ms) ? ms : null;
}

function floorToUtcDay(ms: number): number {
  return Math.floor(ms / 86_400_000) * 86_400_000;
}

/**
 * Strip float32 round-trip artifacts.
 *
 * Yahoo serialises prices from 32-bit floats, so a VIX close of 18.58 arrives as
 * 18.579999923706055. Storing that verbatim is not wrong numerically, but it
 * bloats every downstream display and agent prompt with meaningless digits.
 * Four decimals is far more precision than any index quote carries.
 */
function cleanFloat(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}
