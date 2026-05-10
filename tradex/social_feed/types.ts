export interface SocialAuthor {
  id: string;
  name: string;
  handle: string;
  profileImageUrl: string;
  verified: boolean;
}

export interface SocialMetrics {
  likes: number;
  reposts: number;
  replies: number;
  quotes: number;
  views: number;
  bookmarks: number;
}

export interface SocialFeedItem {
  source: string;
  externalId: string;
  url: string;
  author: SocialAuthor;
  text: string;
  createdAtMs: number;
  fetchedAtMs: number;
  metrics: SocialMetrics;
  urls: string[];
  lang: string;
  isRepost: boolean;
  repostedBy: string | null;
  quotedItem: SocialFeedItem | null;
  raw: Record<string, unknown>;
}

export function defaultMetrics(): SocialMetrics {
  return { likes: 0, reposts: 0, replies: 0, quotes: 0, views: 0, bookmarks: 0 };
}

export function socialItemToPayload(item: SocialFeedItem, includeRaw = false): Record<string, unknown> {
  return {
    source: item.source,
    externalId: item.externalId,
    url: item.url,
    author: item.author,
    text: item.text,
    createdAt: new Date(item.createdAtMs).toISOString(),
    createdAtMs: item.createdAtMs,
    fetchedAtMs: item.fetchedAtMs,
    metrics: item.metrics,
    urls: item.urls,
    lang: item.lang,
    isRepost: item.isRepost,
    repostedBy: item.repostedBy,
    quotedItem: item.quotedItem ? socialItemToPayload(item.quotedItem, false) : null,
    ...(includeRaw ? { raw: item.raw } : {}),
  };
}
