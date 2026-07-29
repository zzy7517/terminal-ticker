import type { NewsItem } from "../types.js";

export type FetchStatus = "ok" | "not_modified" | "rate_limited" | "error";

export interface FetchResult {
  status: FetchStatus;
  items: NewsItem[];
  etag: string | null;
  lastModified: string | null;
  error: string | null;
  httpStatus: number | null;
}

/** Shared contract for news pollers (Reuters sitemap, Forex Factory HTML, …). */
export interface NewsProvider {
  readonly sourceName: string;
  fetch(input?: { etag?: string | null; lastModified?: string | null }): Promise<FetchResult>;
}
