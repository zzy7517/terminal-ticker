import { NewsConfig } from "../config/index.js";
import { ForexFactoryNewsProvider } from "./providers/forexfactory.js";
import { ReutersSitemapProvider } from "./providers/reuters.js";
import type { FetchResult, NewsProvider } from "./providers/types.js";
import { NewsStore } from "./store.js";
import { NewsItem } from "./types.js";

export interface RefreshOutcome {
  status: string;
  inserted: number;
  error: string | null;
  /** Per-source outcomes when multiple providers are polled. */
  sources?: Record<string, { status: string; inserted: number; error: string | null }>;
}

export class NewsService {
  readonly store: NewsStore;
  readonly providers: NewsProvider[];
  readonly config: NewsConfig;
  lastStatus = "idle";
  lastError: string | null = null;
  lastFetchedAtMs: number | null = null;
  private timer: NodeJS.Timeout | null = null;

  constructor(input: {
    config: NewsConfig;
    store?: NewsStore;
    providers?: NewsProvider[];
  }) {
    this.config = input.config;
    this.store = input.store ?? new NewsStore();
    this.providers = input.providers ?? buildDefaultProviders(input.config);
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
    if (this.providers.length === 0) {
      this.lastStatus = "error";
      this.lastError = "no news providers configured";
      return { status: "error", inserted: 0, error: this.lastError, sources: {} };
    }

    const sources: RefreshOutcome["sources"] = {};
    let inserted = 0;
    const errors: string[] = [];
    let anyOk = false;
    let anyNotModified = false;
    let anyRateLimited = false;

    for (const provider of this.providers) {
      const cursor = this.store.getCursor(provider.sourceName);
      let result: FetchResult;
      try {
        result = await provider.fetch({ etag: cursor?.etag, lastModified: cursor?.lastModified });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        errors.push(`${provider.sourceName}: ${message}`);
        sources![provider.sourceName] = { status: "error", inserted: 0, error: message };
        continue;
      }
      if (result.status === "ok") {
        const count = this.store.upsertItems(result.items).length;
        this.store.setCursor(provider.sourceName, result.etag, result.lastModified);
        inserted += count;
        anyOk = true;
        sources![provider.sourceName] = { status: "ok", inserted: count, error: null };
      } else if (result.status === "not_modified") {
        anyNotModified = true;
        sources![provider.sourceName] = { status: "not_modified", inserted: 0, error: null };
      } else {
        const err = result.error ?? result.status;
        errors.push(`${provider.sourceName}: ${err}`);
        sources![provider.sourceName] = { status: result.status, inserted: 0, error: err };
        if (result.status === "rate_limited") anyRateLimited = true;
      }
    }

    if (anyOk) this.pruneOldItems();

    if (anyOk) {
      // Per-provider failures are already visible in `sources`; the aggregate
      // status/error pair stays "ok"/null so callers that only look at the
      // top-level fields (NewsSettingsPanel's error banner) don't flag a
      // healthy refresh as broken just because one of several providers had
      // a bad poll.
      this.lastStatus = "ok";
      this.lastError = null;
      this.lastFetchedAtMs = Date.now();
      return { status: "ok", inserted, error: null, sources };
    }

    if (anyNotModified && errors.length === 0) {
      this.lastStatus = "not_modified";
      this.lastError = null;
      return { status: "not_modified", inserted: 0, error: null, sources };
    }

    this.lastStatus = anyRateLimited ? "rate_limited" : "error";
    this.lastError = errors.join("; ") || "refresh failed";
    return { status: this.lastStatus, inserted: 0, error: this.lastError, sources };
  }

  recent(limit: number | null = null): NewsItem[] {
    return this.store.recent({ limit: limit ?? this.config.recentLimit });
  }

  private pruneOldItems(): void {
    this.store.pruneOlderThan(Date.now() - this.config.retentionDays * 86_400_000);
  }
}

function buildDefaultProviders(config: NewsConfig): NewsProvider[] {
  const providers: NewsProvider[] = [
    new ReutersSitemapProvider({
      url: config.reutersUrl,
      timeoutSeconds: config.requestTimeoutSeconds,
    }),
  ];
  if (config.forexfactoryEnabled) {
    providers.push(
      new ForexFactoryNewsProvider({
        timeoutSeconds: Math.max(config.requestTimeoutSeconds, 15),
      }),
    );
  }
  return providers;
}
