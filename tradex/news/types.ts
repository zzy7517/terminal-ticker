import type { NewsItemPayload } from "../contracts.js";

export interface NewsItem {
  url: string;
  source: string;
  title: string;
  summary: string;
  publishedAtMs: number;
  fetchedAtMs: number;
  keywords: string[];
}

export type { NewsItemPayload } from "../contracts.js";

export function newsItemToPayload(item: NewsItem): NewsItemPayload {
  return {
    url: item.url,
    source: item.source,
    title: item.title,
    summary: item.summary,
    publishedAt: new Date(item.publishedAtMs).toISOString(),
    publishedAtMs: item.publishedAtMs,
    fetchedAtMs: item.fetchedAtMs,
    keywords: item.keywords,
  };
}
