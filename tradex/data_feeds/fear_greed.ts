/**
 * Fear & Greed Index feed — polls alternative.me API.
 */

import { BaseFeed } from "./base_feed.js";
import type { FearGreedData } from "./types.js";

const API_URL = "https://api.alternative.me/fng/?limit=1&format=json";

export class FearGreedFeed extends BaseFeed<FearGreedData> {
  readonly name = "fear_greed";
  readonly pollIntervalMs: number;

  constructor(pollIntervalMs = 3600_000) {
    super();
    this.pollIntervalMs = pollIntervalMs;
  }

  protected async fetch(): Promise<FearGreedData | null> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    try {
      const res = await globalThis.fetch(API_URL, { signal: controller.signal });
      if (!res.ok) return null;
      const json = (await res.json()) as {
        data?: Array<{ value: string; value_classification: string; timestamp: string }>;
      };
      const entry = json.data?.[0];
      if (!entry) return null;
      return {
        value: Number(entry.value),
        classification: entry.value_classification,
        timestamp: new Date(Number(entry.timestamp) * 1000).toISOString(),
      };
    } finally {
      clearTimeout(timeout);
    }
  }
}
