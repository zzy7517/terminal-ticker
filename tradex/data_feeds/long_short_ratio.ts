/**
 * Long/Short Ratio feed — polls Bitget REST API.
 */

import { BaseFeed } from "./base_feed.js";
import type { LongShortRatioData } from "./types.js";

const BITGET_LS_URL = "https://api.bitget.com/api/v2/mix/market/account-long-short";

export interface LongShortFeedConfig {
  symbols: string[];
  productType?: string;
  pollIntervalMs?: number;
}

export class LongShortRatioFeed extends BaseFeed<LongShortRatioData> {
  readonly name = "long_short_ratio";
  readonly pollIntervalMs: number;
  private symbols: string[];
  private productType: string;

  constructor(config: LongShortFeedConfig) {
    super();
    this.symbols = config.symbols;
    this.productType = config.productType ?? "USDT-FUTURES";
    this.pollIntervalMs = config.pollIntervalMs ?? 900_000; // 15m
  }

  protected async fetch(): Promise<LongShortRatioData[] | null> {
    const results: LongShortRatioData[] = [];
    for (const symbol of this.symbols) {
      try {
        const url = `${BITGET_LS_URL}?symbol=${symbol}&productType=${this.productType}&period=5m`;
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 10_000);
        try {
          const res = await globalThis.fetch(url, { signal: controller.signal });
          if (!res.ok) continue;
          const json = (await res.json()) as {
            data?: Array<{ longShortRatio?: string; longRate?: string; shortRate?: string; ts?: string }>;
          };
          const latest = json.data?.[0];
          if (!latest?.longShortRatio) continue;
          results.push({
            instrumentKey: `${this.productType}:${symbol}`,
            ratio: Number(latest.longShortRatio),
            longPct: Number(latest.longRate ?? 0) * 100,
            shortPct: Number(latest.shortRate ?? 0) * 100,
            timestamp: latest.ts ? new Date(Number(latest.ts)).toISOString() : new Date().toISOString(),
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
}
