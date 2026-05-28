/**
 * DataFeedRegistry — unified feed lifecycle and access.
 */

import type { DataFeed, FeedStatus, RegimeDataPack, FearGreedData, FundingSnapshot, LongShortRatioData, OIDeltaData, DXYData } from "./types.js";

export class DataFeedRegistry {
  private feeds = new Map<string, DataFeed<unknown>>();

  register<T>(feed: DataFeed<T>): void {
    this.feeds.set(feed.name, feed as DataFeed<unknown>);
  }

  get<T>(name: string): DataFeed<T> | null {
    return (this.feeds.get(name) as DataFeed<T>) ?? null;
  }

  async startAll(): Promise<void> {
    const promises: Promise<void>[] = [];
    for (const feed of this.feeds.values()) {
      promises.push(feed.start());
    }
    await Promise.allSettled(promises);
  }

  stopAll(): void {
    for (const feed of this.feeds.values()) {
      feed.stop();
    }
  }

  /** Build regime input data pack from all feeds. */
  buildRegimeInput(): RegimeDataPack {
    const fearGreedFeed = this.get<FearGreedData>("fear_greed");
    const fundingFeed = this.get<FundingSnapshot>("funding");
    const lsFeed = this.get<LongShortRatioData>("long_short_ratio");
    const oiFeed = this.get<OIDeltaData>("oi_delta");
    const dxyFeed = this.get<DXYData>("dxy");

    // VIX comes from the market data layer (QuoteState), not from feeds.
    // The orchestrator injects it separately.
    return {
      vix: null,
      fearGreed: fearGreedFeed?.getLatest() ?? null,
      funding: this.collectMap(fundingFeed),
      longShortRatio: this.collectMap(lsFeed),
      oiDelta: this.collectMap(oiFeed),
      dxy: dxyFeed?.getLatest() ?? null,
    };
  }

  /** Snapshot for WebSocket push — all latest values. */
  snapshot(): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    for (const [name, feed] of this.feeds) {
      result[name] = feed.getLatest();
    }
    return result;
  }

  /** Status for /api/feeds/status. */
  statuses(): FeedStatus[] {
    const out: FeedStatus[] = [];
    for (const [name, feed] of this.feeds) {
      const latest = feed.getLatest() as { timestamp?: string } | null;
      const ts = latest?.timestamp ?? null;
      const age = ts ? Math.round((Date.now() - new Date(ts).getTime()) / 1000) : null;
      out.push({
        name,
        lastFetchedAt: ts,
        lastError: feed.getLastError(),
        dataAge: age,
      });
    }
    return out;
  }

  private collectMap<T extends { instrumentKey: string }>(feed: DataFeed<T> | null): Map<string, T> {
    const map = new Map<string, T>();
    if (!feed) return map;
    // For feeds that store per-instrument data, getHistory returns all recent entries
    const items = feed.getHistory(50);
    for (const item of items) {
      map.set(item.instrumentKey, item);
    }
    return map;
  }
}
