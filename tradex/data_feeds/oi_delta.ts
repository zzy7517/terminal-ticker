/**
 * OI Delta feed — computes open interest change from Bitget API.
 */

import { BaseFeed } from "./base_feed.js";
import type { OIDeltaData } from "./types.js";

const BITGET_OI_URL = "https://api.bitget.com/api/v2/mix/market/open-interest";

export interface OIDeltaFeedConfig {
  symbols: string[];
  productType?: string;
  pollIntervalMs?: number;
}

interface OIRecord {
  oi: number;
  timestamp: number;
}

export class OIDeltaFeed extends BaseFeed<OIDeltaData> {
  readonly name = "oi_delta";
  readonly pollIntervalMs: number;
  private symbols: string[];
  private productType: string;
  /** Ring buffer of OI samples per symbol for delta calculation. */
  private samples = new Map<string, OIRecord[]>();
  private maxSamples = 300; // ~5h at 1m intervals

  constructor(config: OIDeltaFeedConfig) {
    super();
    this.symbols = config.symbols;
    this.productType = config.productType ?? "USDT-FUTURES";
    this.pollIntervalMs = config.pollIntervalMs ?? 60_000;
  }

  protected async fetch(): Promise<OIDeltaData[] | null> {
    const results: OIDeltaData[] = [];
    const now = Date.now();

    for (const symbol of this.symbols) {
      try {
        const url = `${BITGET_OI_URL}?symbol=${symbol}&productType=${this.productType}`;
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 10_000);
        try {
          const res = await globalThis.fetch(url, { signal: controller.signal });
          if (!res.ok) continue;
          const json = (await res.json()) as {
            data?: { openInterest?: string };
          };
          const oi = Number(json.data?.openInterest ?? 0);
          if (!oi) continue;

          // Store sample
          const key = `${this.productType}:${symbol}`;
          if (!this.samples.has(key)) this.samples.set(key, []);
          const buf = this.samples.get(key)!;
          buf.push({ oi, timestamp: now });
          if (buf.length > this.maxSamples) buf.splice(0, buf.length - this.maxSamples);

          // Calculate deltas
          const delta1h = this.calcDelta(buf, oi, 3600_000);
          const delta4h = this.calcDelta(buf, oi, 14400_000);
          const delta24h = this.calcDelta(buf, oi, 86400_000);

          results.push({
            instrumentKey: key,
            oi,
            delta1h,
            delta4h,
            delta24h,
            timestamp: new Date().toISOString(),
          });
        } finally {
          clearTimeout(timeout);
        }
      } catch {
        // skip
      }
    }
    return results.length > 0 ? results : null;
  }

  private calcDelta(buf: OIRecord[], currentOi: number, windowMs: number): number {
    const cutoff = Date.now() - windowMs;
    // Find the oldest sample within the window
    const older = buf.find((s) => s.timestamp >= cutoff);
    if (!older) return 0;
    return currentOi - older.oi;
  }
}
