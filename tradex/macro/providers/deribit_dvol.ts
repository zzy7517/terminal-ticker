/**
 * Deribit DVOL provider — crypto-native implied volatility index.
 *
 * Free, no auth. Prioritised over VIX because our execution venue is a crypto
 * perp exchange: DVOL is the implied vol of BTC/ETH options, whereas VIX
 * describes S&P 500 options and only transmits to crypto indirectly.
 *
 * Docs: https://docs.deribit.com/#public-get_volatility_index_data
 * Verified response shape (2026-07-26):
 *   { result: { data: [[ts, open, high, low, close], ...], continuation: null } }
 */

import type { MacroPoint } from "../domain.js";

const DERIBIT_BASE = "https://www.deribit.com/api/v2/public/get_volatility_index_data";

/** Hourly bars — DVOL does not move fast enough to justify finer resolution. */
const RESOLUTION_SECONDS = 3600;

/** Deribit rejects windows wider than this, so backfill is chunked. */
const MAX_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

interface DvolResponse {
  result?: { data?: unknown[][] };
  error?: { message?: string; code?: number };
}

export class DeribitDvolProvider {
  readonly name = "deribit";
  /** Free and keyless, so always usable. */
  readonly available = true;

  /** Series id for a currency, e.g. "BTC" -> "dvol_btc". */
  static seriesId(currency: string): string {
    return `dvol_${currency.toLowerCase()}`;
  }

  /**
   * Fetch the DVOL series for one currency between two instants.
   *
   * Values are real-time (no revision), so `vintageTs` is null throughout.
   */
  async fetchDvol(currency: string, fromMs: number, toMs: number): Promise<MacroPoint[]> {
    const seriesId = DeribitDvolProvider.seriesId(currency);
    const points: MacroPoint[] = [];

    // Walk forward in windows Deribit will accept rather than issuing one huge
    // request that silently returns a truncated range.
    for (let start = fromMs; start < toMs; start += MAX_WINDOW_MS) {
      const end = Math.min(start + MAX_WINDOW_MS, toMs);
      points.push(...(await this.fetchWindow(seriesId, currency, start, end)));
    }

    return points;
  }

  private async fetchWindow(
    seriesId: string,
    currency: string,
    fromMs: number,
    toMs: number,
  ): Promise<MacroPoint[]> {
    const params = new URLSearchParams({
      currency: currency.toUpperCase(),
      start_timestamp: String(fromMs),
      end_timestamp: String(toMs),
      resolution: String(RESOLUTION_SECONDS),
    });

    const response = await fetch(`${DERIBIT_BASE}?${params.toString()}`);
    const payload = (await response.json().catch(() => null)) as DvolResponse | null;

    if (!response.ok || payload?.error) {
      const detail = payload?.error?.message ?? response.statusText;
      throw new Error(`Deribit DVOL ${currency} failed: ${response.status} ${detail}`);
    }

    const rows = payload?.result?.data ?? [];
    const points: MacroPoint[] = [];

    for (const row of rows) {
      // [timestamp, open, high, low, close] — take the close as the bar's value.
      if (!Array.isArray(row) || row.length < 5) continue;
      const ts = Number(row[0]);
      const close = Number(row[4]);
      if (!Number.isFinite(ts)) continue;
      points.push({
        seriesId,
        ts,
        value: Number.isFinite(close) ? close : null,
        vintageTs: null,
      });
    }

    return points;
  }
}
