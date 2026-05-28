/**
 * Funding rate history feed — polls Bitget REST API.
 */

import { BaseFeed } from "./base_feed.js";
import type { FundingSnapshot } from "./types.js";

const BITGET_FUNDING_URL = "https://api.bitget.com/api/v2/mix/market/current-fund-rate";

export interface FundingFeedConfig {
  symbols: string[];       // e.g. ["BTCUSDT", "ETHUSDT"]
  productType?: string;    // default "USDT-FUTURES"
  pollIntervalMs?: number; // default 60s
}

export class FundingHistoryFeed extends BaseFeed<FundingSnapshot> {
  readonly name = "funding";
  readonly pollIntervalMs: number;
  private symbols: string[];
  private productType: string;

  constructor(config: FundingFeedConfig) {
    super();
    this.symbols = config.symbols;
    this.productType = config.productType ?? "USDT-FUTURES";
    this.pollIntervalMs = config.pollIntervalMs ?? 60_000;
  }

  protected async fetch(): Promise<FundingSnapshot[] | null> {
    const results: FundingSnapshot[] = [];
    for (const symbol of this.symbols) {
      try {
        const url = `${BITGET_FUNDING_URL}?symbol=${symbol}&productType=${this.productType}`;
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 10_000);
        try {
          const res = await globalThis.fetch(url, { signal: controller.signal });
          if (!res.ok) continue;
          const json = (await res.json()) as {
            data?: { symbol?: string; fundingRate?: string; nextFundingTime?: string };
          };
          const d = json.data;
          if (!d?.fundingRate) continue;
          results.push({
            instrumentKey: `${this.productType}:${symbol}`,
            rate: Number(d.fundingRate),
            nextFundingTime: d.nextFundingTime ?? "",
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
