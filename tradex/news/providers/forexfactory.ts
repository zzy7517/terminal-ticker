/**
 * Forex Factory news headlines.
 *
 * FF has no official news API. The listing page is HTML behind Cloudflare;
 * `wreq-js` (same stack as Reuters) clears the challenge. We only persist
 * id + title + FF URL — see product note on NewsItem mapping below.
 */

import { fetch as browserFetch } from "wreq-js";
import type { NewsItem } from "../types.js";
import type { FetchResult, NewsProvider } from "./types.js";

export const FOREXFACTORY_SOURCE = "forexfactory";
export const DEFAULT_FOREXFACTORY_NEWS_URL = "https://www.forexfactory.com/news";

export class ForexFactoryNewsProvider implements NewsProvider {
  readonly sourceName = FOREXFACTORY_SOURCE;
  readonly url: string;
  readonly timeoutSeconds: number;

  constructor(input: { url?: string; timeoutSeconds?: number } = {}) {
    this.url = input.url ?? DEFAULT_FOREXFACTORY_NEWS_URL;
    this.timeoutSeconds = input.timeoutSeconds ?? 15;
  }

  async fetch(): Promise<FetchResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutSeconds * 1000);
    try {
      const response = await browserFetch(this.url, {
        profile: "safari_17_0",
        operatingSystem: "macos",
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15",
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "en-US,en;q=0.9",
        },
        signal: controller.signal,
      } as never);

      if ([401, 403, 429].includes(response.status)) {
        return {
          status: "rate_limited",
          items: [],
          etag: null,
          lastModified: null,
          error: `HTTP ${response.status}`,
          httpStatus: response.status,
        };
      }
      if (!response.ok) {
        return {
          status: "error",
          items: [],
          etag: null,
          lastModified: null,
          error: `HTTP ${response.status}`,
          httpStatus: response.status,
        };
      }

      const html = await response.text();
      // wreq can clear the bot wall and still land on a challenge shell with HTTP 200.
      if (isCloudflareChallengeHtml(html)) {
        return {
          status: "rate_limited",
          items: [],
          etag: null,
          lastModified: null,
          error: "cloudflare challenge page",
          httpStatus: response.status,
        };
      }
      return {
        status: "ok",
        items: parseForexFactoryNewsHtml(html),
        etag: response.headers.get("etag"),
        lastModified: response.headers.get("last-modified"),
        error: null,
        httpStatus: response.status,
      };
    } catch (error) {
      return {
        status: "error",
        items: [],
        etag: null,
        lastModified: null,
        error: error instanceof Error ? error.message : String(error),
        httpStatus: null,
      };
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * Extract headline rows from the FF news listing HTML.
 *
 * Stored shape:
 * - `url`     — canonical FF story URL (contains numeric id)
 * - `title`   — headline text
 * - `source`  — `forexfactory`
 * - `keywords`— `[id]` so the numeric id is queryable without a schema change
 * - summary / publishedAt are unused (publishedAt falls back to fetch time)
 */
export function parseForexFactoryNewsHtml(html: string, fetchedAtMs = Date.now()): NewsItem[] {
  const re = /<a href="(\/news\/(\d+)-[^"#]+)"[^>]*>\s*([^<]{8,220})\s*<\/a>/gi;
  const seen = new Set<string>();
  const items: NewsItem[] = [];

  for (const match of html.matchAll(re)) {
    const path = match[1];
    const id = match[2];
    const title = decodeHtml(match[3]);
    if (!title || isNoiseTitle(title)) continue;
    if (seen.has(id)) continue;
    seen.add(id);

    items.push({
      url: `https://www.forexfactory.com${path}`,
      source: FOREXFACTORY_SOURCE,
      title,
      summary: "",
      publishedAtMs: fetchedAtMs,
      fetchedAtMs,
      keywords: [id],
    });
  }

  return items;
}

function isNoiseTitle(title: string): boolean {
  return /^from /i.test(title) || /^\d+\s+comments?$/i.test(title);
}

/** Exported for regression tests — challenge shells must not parse as empty-ok. */
export function isCloudflareChallengeHtml(html: string): boolean {
  return /Just a moment|cf-challenge|cf-mitigated|Attention Required/i.test(html);
}

function decodeHtml(value: string): string {
  return value
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
