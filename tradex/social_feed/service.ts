import { SocialFeedConfig } from "../config/index.js";
import { XInternalClient } from "./providers/x_internal.js";
import { SocialFeedStore } from "./store.js";
import { SocialFeedItem } from "./types.js";

export interface SocialFeedRefreshOutcome {
  status: string;
  inserted: number;
  error: string | null;
}

export interface SocialFeedSearchOutcome {
  status: string;
  items: SocialFeedItem[];
  error: string | null;
}

export class SocialFeedService {
  readonly config: SocialFeedConfig;
  readonly store: SocialFeedStore;
  readonly clientFactory: () => XInternalClient;

  constructor(input: { config: SocialFeedConfig; store?: SocialFeedStore; clientFactory?: () => XInternalClient }) {
    this.config = input.config;
    this.store = input.store ?? new SocialFeedStore();
    this.clientFactory = input.clientFactory ?? (() => XInternalClient.fromEnv());
  }

  async refreshXFollowing(input: { count?: number } = {}): Promise<SocialFeedRefreshOutcome> {
    try {
      const items = (await this.clientFactory().fetchFollowingFeed({ count: input.count ?? 20 })) as SocialFeedItem[];
      this.store.upsertItems(items);
      this.prune();
      return { status: "ok", inserted: items.length, error: null };
    } catch (error) {
      return { status: "error", inserted: 0, error: error instanceof Error ? error.message : String(error) };
    }
  }

  recentItems(input: { source?: string | null; limit?: number; sinceMs?: number | null } = {}): SocialFeedItem[] {
    return this.store.recentItems({ source: input.source, limit: input.limit ?? this.config.recentLimit, sinceMs: input.sinceMs });
  }

  async searchXTweets(input: { query: string; count?: number; product?: string }): Promise<SocialFeedSearchOutcome> {
    try {
      const items = (await this.clientFactory().fetchSearch({ query: input.query, count: input.count ?? 20, product: input.product ?? "Latest" })) as SocialFeedItem[];
      this.store.upsertItems(items);
      this.prune();
      return { status: "ok", items, error: null };
    } catch (error) {
      return { status: "error", items: [], error: error instanceof Error ? error.message : String(error) };
    }
  }

  private prune(): void {
    this.store.pruneItemsOlderThan(Date.now() - this.config.retentionDays * 86_400_000);
    this.store.trimItems({ maxItems: this.config.maxItems });
  }
}
