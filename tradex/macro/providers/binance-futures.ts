/**
 * Binance futures positioning provider — open interest and long/short balance.
 *
 * Free, no auth. Binance holds the dominant share of crypto perp volume, so its
 * OI and long/short skew serve as a proxy for market-wide positioning.
 *
 * Docs: https://developers.binance.com/docs/derivatives/usds-margined-futures/market-data
 * Verified response shapes (2026-07-26):
 *   openInterestHist        [{ symbol, sumOpenInterest, sumOpenInterestValue, timestamp }]
 *   topLongShortPositionRatio [{ symbol, longAccount, longShortRatio, shortAccount, timestamp }]
 *   takerlongshortRatio     [{ buySellRatio, buyVol, sellVol, timestamp }]
 *
 * NOTE: these endpoints only retain roughly 30 days of history, so deep
 * backfill is not possible regardless of the configured window.
 */

import type { MacroPoint } from "../domain.js";

const FAPI_BASE = "https://fapi.binance.com/futures/data";

/** Binance caps `limit` at 500 rows per request. */
const MAX_LIMIT = 500;

/** Bar width. 5m matches the finest granularity these endpoints offer. */
const PERIOD = "5m";

type BinanceMetric = "oi" | "ls_ratio" | "taker_ratio";

interface Endpoint {
  path: string;
  /** Field carrying the value we store. */
  field: string;
}

const ENDPOINTS: Record<BinanceMetric, Endpoint> = {
  // Coin-denominated OI rather than notional USD: it isolates position changes
  // from price moves, so a flat OI during a 10% rally reads as "no new
  // positioning" instead of a spurious 10% increase.
  oi: { path: "openInterestHist", field: "sumOpenInterest" },
  ls_ratio: { path: "topLongShortPositionRatio", field: "longShortRatio" },
  taker_ratio: { path: "takerlongshortRatio", field: "buySellRatio" },
};

export class BinanceFuturesProvider {
  readonly name = "binance";
  /** Free and keyless, so always usable. */
  readonly available = true;

  /** Series id, e.g. ("BTCUSDT", "oi") -> "binance_oi_btc". */
  static seriesId(symbol: string, metric: BinanceMetric): string {
    return `binance_${metric}_${baseAsset(symbol)}`;
  }

  static readonly METRICS: BinanceMetric[] = ["oi", "ls_ratio", "taker_ratio"];

  /** Fetch one metric for one symbol. Values are real-time (no revisions). */
  async fetchMetric(symbol: string, metric: BinanceMetric, limit = MAX_LIMIT): Promise<MacroPoint[]> {
    const endpoint = ENDPOINTS[metric];
    const seriesId = BinanceFuturesProvider.seriesId(symbol, metric);
    const params = new URLSearchParams({
      symbol: symbol.toUpperCase(),
      period: PERIOD,
      limit: String(Math.min(Math.max(limit, 1), MAX_LIMIT)),
    });

    const response = await fetch(`${FAPI_BASE}/${endpoint.path}?${params.toString()}`);
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(
        `Binance ${endpoint.path} ${symbol} failed: ${response.status} ${body.slice(0, 200)}`,
      );
    }

    const rows = (await response.json()) as unknown;
    if (!Array.isArray(rows)) {
      throw new Error(`Binance ${endpoint.path} ${symbol} returned a non-array body`);
    }

    const points: MacroPoint[] = [];
    for (const row of rows) {
      if (!row || typeof row !== "object") continue;
      const record = row as Record<string, unknown>;
      const ts = Number(record.timestamp);
      if (!Number.isFinite(ts)) continue;
      // Binance serialises numbers as strings; Number() handles both.
      const value = Number(record[endpoint.field]);
      points.push({
        seriesId,
        ts,
        value: Number.isFinite(value) ? value : null,
        vintageTs: null,
      });
    }

    return points;
  }
}

/** "BTCUSDT" -> "btc". Falls back to the whole symbol when no quote suffix matches. */
function baseAsset(symbol: string): string {
  const upper = symbol.toUpperCase();
  for (const quote of ["USDT", "USDC", "BUSD", "USD"]) {
    if (upper.endsWith(quote) && upper.length > quote.length) {
      return upper.slice(0, -quote.length).toLowerCase();
    }
  }
  return upper.toLowerCase();
}
