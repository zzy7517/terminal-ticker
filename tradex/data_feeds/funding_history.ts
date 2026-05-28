/**
 * Funding rate history feed — polls Bitget REST API.
 */

import { BaseFeed } from "./base_feed.js";
import type { FundingSnapshot } from "./types.js";

const BITGET_FUNDING_URL = "https://api.bitget.com/api/v2/mix/market/current-fund-rate";

export interface FundingFeedTarget {
  instrumentKey: string;
  symbol: string;
  productType: string;
}

export interface FundingFeedConfig {
  targets?: FundingFeedTarget[];
  symbols?: string[];       // legacy shorthand, e.g. ["BTCUSDT", "ETHUSDT"]
  productType?: string;     // default "USDT-FUTURES"
  pollIntervalMs?: number;  // default 60s
}

export class FundingHistoryFeed extends BaseFeed<FundingSnapshot> {
  readonly name = "funding";
  readonly pollIntervalMs: number;
  private targets: FundingFeedTarget[];

  constructor(config: FundingFeedConfig) {
    super();
    const productType = config.productType ?? "USDT-FUTURES";
    this.targets = config.targets ?? (config.symbols ?? []).map((symbol) => ({
      instrumentKey: `${productType}:${symbol}`,
      symbol,
      productType,
    }));
    this.pollIntervalMs = config.pollIntervalMs ?? 60_000;
  }

  protected async fetch(): Promise<FundingSnapshot[] | null> {
    const results: FundingSnapshot[] = [];
    for (const target of this.targets) {
      try {
        const url = new URL(BITGET_FUNDING_URL);
        url.searchParams.set("symbol", target.symbol);
        url.searchParams.set("productType", target.productType);
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 10_000);
        try {
          const res = await globalThis.fetch(url, { signal: controller.signal });
          if (!res.ok) continue;
          const json = (await res.json()) as {
            data?: Array<{ symbol?: string; fundingRate?: string; nextUpdate?: string; nextFundingTime?: string }> | { symbol?: string; fundingRate?: string; nextUpdate?: string; nextFundingTime?: string };
          };
          const d = Array.isArray(json.data) ? json.data[0] : json.data;
          if (!d?.fundingRate) continue;
          results.push({
            instrumentKey: target.instrumentKey,
            rate: Number(d.fundingRate),
            nextFundingTime: d.nextUpdate ?? d.nextFundingTime ?? "",
            timestamp: new Date().toISOString(),
          });
        } finally {
          clearTimeout(timeout);
        }
      } catch {
        // skip individual symbol failures
      }
    }
    return results.length > 0 ? results : null;
  }
}
