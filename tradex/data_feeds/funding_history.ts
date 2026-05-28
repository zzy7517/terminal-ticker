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

export function parseFundingSnapshot(raw: unknown, target: FundingFeedTarget, timestamp = new Date().toISOString()): FundingSnapshot | null {
  const payload = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  const data = payload.data;
  const d = Array.isArray(data) ? data[0] : data;
  if (!d || typeof d !== "object" || Array.isArray(d)) return null;
  const row = d as Record<string, unknown>;
  const fundingRate = row.fundingRate;
  if (fundingRate === null || fundingRate === undefined || fundingRate === "") return null;
  const rate = Number(fundingRate);
  if (!Number.isFinite(rate)) return null;
  return {
    instrumentKey: target.instrumentKey,
    rate,
    nextFundingTime: String(row.nextUpdate ?? row.nextFundingTime ?? ""),
    timestamp,
  };
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
          const parsed = parseFundingSnapshot(await res.json(), target);
          if (parsed) results.push(parsed);
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
