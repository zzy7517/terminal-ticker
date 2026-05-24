import { NewsConfig } from "../config/index.js";
import { ReutersSitemapProvider } from "./providers/reuters.js";
import { NewsStore } from "./store.js";
import { NewsItem } from "./types.js";

export interface RefreshOutcome {
  status: string;
  inserted: number;
  error: string | null;
}

export class NewsService {
  readonly store: NewsStore;
  readonly provider: ReutersSitemapProvider;
  readonly config: NewsConfig;
  lastStatus = "idle";
  lastError: string | null = null;
  lastFetchedAtMs: number | null = null;
  private timer: NodeJS.Timeout | null = null;

  constructor(input: { config: NewsConfig; store?: NewsStore; provider?: ReutersSitemapProvider }) {
    this.config = input.config;
    this.store = input.store ?? new NewsStore();
    this.provider = input.provider ?? new ReutersSitemapProvider({ url: input.config.reutersUrl, timeoutSeconds: input.config.requestTimeoutSeconds });
  }

  async start(): Promise<void> {
    if (!this.config.enabled || this.timer) return;
    void this.refreshNow();
    this.timer = setInterval(() => void this.refreshNow(), this.config.pollIntervalSeconds * 1000);
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async refreshNow(): Promise<RefreshOutcome> {
    const cursor = this.store.getCursor(this.provider.sourceName);
    const result = await this.provider.fetch({ etag: cursor?.etag, lastModified: cursor?.lastModified });
    if (result.status === "ok") {
      const inserted = this.store.upsertItems(result.items).length;
      this.store.setCursor(this.provider.sourceName, result.etag, result.lastModified);
      this.pruneOldItems();
      this.lastStatus = "ok";
      this.lastError = null;
      this.lastFetchedAtMs = Date.now();
      return { status: "ok", inserted, error: null };
    }
    this.lastStatus = result.status;
    this.lastError = result.error;
    return { status: result.status, inserted: 0, error: result.error };
  }

  recent(limit: number | null = null): NewsItem[] {
    return this.store.recent({ limit: limit ?? this.config.recentLimit });
  }

  private pruneOldItems(): void {
    this.store.pruneOlderThan(Date.now() - this.config.retentionDays * 86_400_000);
  }
}
