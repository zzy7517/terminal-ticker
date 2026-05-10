import { SocialFeedItem, defaultMetrics } from "../types.js";

export const SOURCE_NAME = "x_following";
export const SEARCH_SOURCE_NAME = "x_search";
const BEARER_TOKEN = "AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA";
const FALLBACK_QUERY_IDS: Record<string, string> = {
  HomeLatestTimeline: "BKB7oi212Fi7kQtCBGE4zA",
  SearchTimeline: "VhUd6vHVmLBcw0uX-6jMLA",
};

export class XInternalError extends Error {
  readonly statusCode: number;
  constructor(message: string, statusCode = 0) {
    super(message);
    this.statusCode = statusCode;
  }
}

export class XAuthenticationError extends XInternalError {}

export interface XCookieAuth {
  authToken: string;
  ct0: string;
  cookieString?: string | null;
}

export function loadXCookieAuthFromEnv(): XCookieAuth {
  const authToken = process.env.TWITTER_AUTH_TOKEN?.trim();
  const ct0 = process.env.TWITTER_CT0?.trim();
  if (!authToken || !ct0) throw new XAuthenticationError("missing TWITTER_AUTH_TOKEN/TWITTER_CT0; copy auth_token and ct0 cookies from x.com", 401);
  return { authToken, ct0, cookieString: process.env.TWITTER_COOKIE_STRING?.trim() || null };
}

function deepGet(data: unknown, ...keys: Array<string | number>): unknown {
  let current = data;
  for (const key of keys) {
    if (typeof key === "number") current = Array.isArray(current) ? current[key] : undefined;
    else current = current && typeof current === "object" && !Array.isArray(current) ? (current as Record<string, unknown>)[key] : undefined;
    if (current === undefined || current === null) return null;
  }
  return current;
}

function parseIntSafe(value: unknown): number {
  const parsed = Number.parseInt(String(value || "0").replace(/,/g, ""), 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

function createdAtMs(value: string, fallbackMs: number): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : fallbackMs;
}

function buildGraphqlUrl(queryId: string, operationName: string, variables: Record<string, unknown>): string {
  const features = {
    responsive_web_graphql_exclude_directive_enabled: true,
    creator_subscriptions_tweet_preview_api_enabled: true,
    responsive_web_graphql_timeline_navigation_enabled: true,
    longform_notetweets_consumption_enabled: true,
    longform_notetweets_rich_text_read_enabled: true,
    view_counts_everywhere_api_enabled: true,
  };
  return `https://x.com/i/api/graphql/${queryId}/${operationName}?variables=${encodeURIComponent(JSON.stringify(variables))}&features=${encodeURIComponent(JSON.stringify(features))}`;
}

function parseTweetResult(result: Record<string, unknown>, fetchedAtMs: number, source: string): SocialFeedItem | null {
  const tweetData = result.__typename === "TweetWithVisibilityResults" && result.tweet && typeof result.tweet === "object" ? (result.tweet as Record<string, unknown>) : result;
  const legacy = tweetData.legacy && typeof tweetData.legacy === "object" ? (tweetData.legacy as Record<string, unknown>) : null;
  const core = tweetData.core && typeof tweetData.core === "object" ? (tweetData.core as Record<string, unknown>) : null;
  if (!legacy || !core) return null;
  const user = (deepGet(core, "user_results", "result") || {}) as Record<string, unknown>;
  const userLegacy = (user.legacy || {}) as Record<string, unknown>;
  const userCore = (user.core || {}) as Record<string, unknown>;
  const tweetId = String(tweetData.rest_id || "");
  const handle = String(userCore.screen_name || userLegacy.screen_name || "unknown");
  const urlsRaw = deepGet(legacy, "entities", "urls");
  const urls = Array.isArray(urlsRaw) ? urlsRaw.map((x) => (x && typeof x === "object" ? String((x as Record<string, unknown>).expanded_url || (x as Record<string, unknown>).url || "") : "")).filter(Boolean) : [];
  return {
    source,
    externalId: tweetId,
    url: tweetId ? `https://x.com/${handle}/status/${tweetId}` : "",
    author: {
      id: String(user.rest_id || ""),
      name: String(userCore.name || userLegacy.name || "Unknown"),
      handle,
      profileImageUrl: String((user.avatar as Record<string, unknown> | undefined)?.image_url || userLegacy.profile_image_url_https || ""),
      verified: Boolean(user.is_blue_verified || userLegacy.verified),
    },
    text: String(deepGet(tweetData, "note_tweet", "note_tweet_results", "result", "text") || legacy.full_text || ""),
    createdAtMs: createdAtMs(String(legacy.created_at || ""), fetchedAtMs),
    fetchedAtMs,
    metrics: {
      ...defaultMetrics(),
      likes: parseIntSafe(legacy.favorite_count),
      reposts: parseIntSafe(legacy.retweet_count),
      replies: parseIntSafe(legacy.reply_count),
      quotes: parseIntSafe(legacy.quote_count),
      views: parseIntSafe(deepGet(tweetData, "views", "count")),
      bookmarks: parseIntSafe(legacy.bookmark_count),
    },
    urls,
    lang: String(legacy.lang || ""),
    isRepost: Boolean(deepGet(legacy, "retweeted_status_result", "result")),
    repostedBy: null,
    quotedItem: null,
    raw: { typename: tweetData.__typename || "" },
  };
}

function parseTimelineResponse(data: unknown, fetchedAtMs: number, source: string): { items: SocialFeedItem[]; cursor: string | null } {
  const instructions = deepGet(data, "data", "home", "home_timeline_urt", "instructions") || deepGet(data, "data", "search_by_raw_query", "search_timeline", "timeline", "instructions");
  const items: SocialFeedItem[] = [];
  let cursor: string | null = null;
  if (!Array.isArray(instructions)) return { items, cursor };
  for (const instruction of instructions) {
    if (!instruction || typeof instruction !== "object") continue;
    const entries = ((instruction as Record<string, unknown>).entries || (instruction as Record<string, unknown>).moduleItems || []) as unknown[];
    for (const entry of entries) {
      const content = entry && typeof entry === "object" ? (entry as Record<string, unknown>).content : null;
      if (!content || typeof content !== "object") continue;
      if ((content as Record<string, unknown>).cursorType === "Bottom") cursor = String((content as Record<string, unknown>).value || "");
      const result = deepGet(content, "itemContent", "tweet_results", "result");
      if (result && typeof result === "object" && !Array.isArray(result)) {
        const item = parseTweetResult(result as Record<string, unknown>, fetchedAtMs, source);
        if (item) items.push(item);
      }
    }
  }
  return { items, cursor };
}

export class XInternalClient {
  readonly auth: XCookieAuth;
  readonly maxRetries: number;

  constructor(auth: XCookieAuth, input: { maxRetries?: number } = {}) {
    this.auth = auth;
    this.maxRetries = input.maxRetries ?? 2;
  }

  static fromEnv(): XInternalClient {
    return new XInternalClient(loadXCookieAuthFromEnv());
  }

  async fetchFollowingFeed(input: { count?: number; cursor?: string | null; returnCursor?: boolean } = {}): Promise<SocialFeedItem[] | [SocialFeedItem[], string | null]> {
    const result = await this.fetchTimeline("HomeLatestTimeline", { count: Math.max(1, input.count ?? 20), includePromotedContent: false, latestControlAvailable: true, requestContext: "launch", ...(input.cursor ? { cursor: input.cursor } : {}) }, SOURCE_NAME);
    return input.returnCursor ? [result.items, result.cursor] : result.items;
  }

  async fetchSearch(input: { query: string; count?: number; product?: string; cursor?: string | null; returnCursor?: boolean }): Promise<SocialFeedItem[] | [SocialFeedItem[], string | null]> {
    const result = await this.fetchTimeline("SearchTimeline", { count: Math.max(1, input.count ?? 20), rawQuery: input.query, querySource: "typed_query", product: input.product || "Latest", ...(input.cursor ? { cursor: input.cursor } : {}) }, SEARCH_SOURCE_NAME);
    return input.returnCursor ? [result.items, result.cursor] : result.items;
  }

  private async fetchTimeline(operationName: string, variables: Record<string, unknown>, source: string): Promise<{ items: SocialFeedItem[]; cursor: string | null }> {
    const queryId = FALLBACK_QUERY_IDS[operationName];
    const data = await this.apiRequest(buildGraphqlUrl(queryId, operationName, variables));
    return parseTimelineResponse(data, Date.now(), source);
  }

  private async apiRequest(url: string): Promise<unknown> {
    const response = await fetch(url, { headers: this.headers() });
    if (response.status === 401 || response.status === 403) throw new XAuthenticationError("X cookie expired or invalid; refresh TWITTER_AUTH_TOKEN/TWITTER_CT0", response.status);
    if (!response.ok) throw new XInternalError(`X API error ${response.status}: ${(await response.text()).slice(0, 500)}`, response.status);
    return response.json();
  }

  private headers(): Record<string, string> {
    const cookie = this.auth.cookieString || `auth_token=${this.auth.authToken}; ct0=${this.auth.ct0}`;
    return {
      Authorization: `Bearer ${BEARER_TOKEN}`,
      Cookie: cookie,
      "X-Csrf-Token": this.auth.ct0,
      "X-Twitter-Active-User": "yes",
      "X-Twitter-Auth-Type": "OAuth2Session",
      "X-Twitter-Client-Language": "en",
      "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36",
      Origin: "https://x.com",
      Referer: "https://x.com/",
      Accept: "*/*",
      "Accept-Language": "en-US,en;q=0.9",
    };
  }
}
