/**
 * Long/Short Ratio feed — polls Bitget REST API.
 */

import { BaseFeed } from "./base_feed.js";
import type { LongShortRatioData } from "./types.js";

const BITGET_LS_URL = "https://api.bitget.com/api/v2/mix/market/account-long-short";

export interface LongShortFeedTarget {
  instrumentKey: string;
  symbol: string;
  productType: string;
}

export interface LongShortFeedConfig {
  targets?: LongShortFeedTarget[];
  symbols?: string[];
  productType?: string;
  pollIntervalMs?: number;
}

export class LongShortRatioFeed extends BaseFeed<LongShortRatioData> {
  readonly name = "long_short_ratio";
  readonly pollIntervalMs: number;
  private targets: LongShortFeedTarget[];

  constructor(config: LongShortFeedConfig) {
    super();
    const productType = config.productType ?? "USDT-FUTURES";
    this.targets = config.targets ?? (config.symbols ?? []).map((symbol) => ({
      instrumentKey: `${productType}:${symbol}`,
      symbol,
      productType,
    }));
    this.pollIntervalMs = config.pollIntervalMs ?? 900_000; // 15m
  }

  protected async fetch(): Promise<LongShortRatioData[] | null> {
    const results: LongShortRatioData[] = [];
    for (const target of this.targets) {
      try {
        const url = new URL(BITGET_LS_URL);
        url.searchParams.set("symbol", target.symbol);
        url.searchParams.set("productType", target.productType);
        url.searchParams.set("period", "5m");
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 10_000);
        try {
          const res = await globalThis.fetch(url, { signal: controller.signal });
          if (!res.ok) continue;
          const json = (await res.json()) as {
            data?: Array<{
              longShortRatio?: string;
              longRate?: string;
              shortRate?: string;
              longShortAccountRatio?: string;
              longAccountRatio?: string;
              shortAccountRatio?: string;
              ts?: string;
            }>;
          };
          const latest = json.data?.[0];
          const ratio = latest?.longShortRatio ?? latest?.longShortAccountRatio;
          if (!ratio) continue;
          results.push({
            instrumentKey: target.instrumentKey,
            ratio: Number(ratio),
            longPct: Number(latest?.longRate ?? latest?.longAccountRatio ?? 0) * 100,
            shortPct: Number(latest?.shortRate ?? latest?.shortAccountRatio ?? 0) * 100,
            timestamp: latest?.ts ? new Date(Number(latest.ts)).toISOString() : new Date().toISOString(),
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
