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

export function parseLongShortRatioData(raw: unknown, target: LongShortFeedTarget): LongShortRatioData | null {
  const payload = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  const data = Array.isArray(payload.data) ? payload.data : [];
  const latest = data[0];
  if (!latest || typeof latest !== "object" || Array.isArray(latest)) return null;
  const row = latest as Record<string, unknown>;
  const ratioRaw = row.longShortRatio ?? row.longShortAccountRatio;
  if (ratioRaw === null || ratioRaw === undefined || ratioRaw === "") return null;
  const ratio = Number(ratioRaw);
  if (!Number.isFinite(ratio)) return null;
  const longPct = Number(row.longRate ?? row.longAccountRatio ?? 0) * 100;
  const shortPct = Number(row.shortRate ?? row.shortAccountRatio ?? 0) * 100;
  return {
    instrumentKey: target.instrumentKey,
    ratio,
    longPct: Number.isFinite(longPct) ? longPct : 0,
    shortPct: Number.isFinite(shortPct) ? shortPct : 0,
    timestamp: row.ts ? new Date(Number(row.ts)).toISOString() : new Date().toISOString(),
  };
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
          const parsed = parseLongShortRatioData(await res.json(), target);
          if (parsed) results.push(parsed);
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
