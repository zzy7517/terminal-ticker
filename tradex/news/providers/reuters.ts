import { fetch as browserFetch } from "wreq-js";
import { NewsItem } from "../types.js";
import type { FetchResult, NewsProvider } from "./types.js";

export const REUTERS_SOURCE = "reuters";
export const DEFAULT_SITEMAP_URL = "https://www.reuters.com/arc/outboundfeeds/news-sitemap/?outputType=xml";

export type { FetchResult, FetchStatus } from "./types.js";

export class ReutersSitemapProvider implements NewsProvider {
  readonly url: string;
  readonly timeoutSeconds: number;
  readonly sourceName = REUTERS_SOURCE;

  constructor(input: { url?: string; timeoutSeconds?: number } = {}) {
    this.url = input.url ?? DEFAULT_SITEMAP_URL;
    this.timeoutSeconds = input.timeoutSeconds ?? 10;
  }

  async fetch(input: { etag?: string | null; lastModified?: string | null } = {}): Promise<FetchResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutSeconds * 1000);
    try {
      const headers: Record<string, string> = {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15",
        Accept: "application/xml,application/xhtml+xml,text/xml;q=0.9,*/*;q=0.8",
      };
      if (input.etag) headers["If-None-Match"] = input.etag;
      if (input.lastModified) headers["If-Modified-Since"] = input.lastModified;
      const response = await browserFetch(this.url, {
        profile: "safari_17_0",
        operatingSystem: "macos",
        headers,
        signal: controller.signal,
      } as never);
      if (response.status === 304) return { status: "not_modified", items: [], etag: input.etag ?? null, lastModified: input.lastModified ?? null, error: null, httpStatus: 304 };
      if ([401, 403, 429].includes(response.status)) return { status: "rate_limited", items: [], etag: null, lastModified: null, error: `HTTP ${response.status}`, httpStatus: response.status };
      if (!response.ok) return { status: "error", items: [], etag: null, lastModified: null, error: `HTTP ${response.status}`, httpStatus: response.status };
      const text = await response.text();
      return {
        status: "ok",
        items: parseSitemap(text),
        etag: response.headers.get("etag"),
        lastModified: response.headers.get("last-modified"),
        error: null,
        httpStatus: response.status,
      };
    } catch (error) {
      return { status: "error", items: [], etag: null, lastModified: null, error: error instanceof Error ? error.message : String(error), httpStatus: null };
    } finally {
      clearTimeout(timer);
    }
  }
}

export function parseSitemap(xmlText: string): NewsItem[] {
  const fetchedAtMs = Date.now();
  const blocks = xmlText.match(/<url>[\s\S]*?<\/url>/g) ?? [];
  return blocks
    .map((block) => {
      const loc = findText(block, "loc");
      const title = findText(block, "news:title");
      if (!loc || !title) return null;
      const publishedAtMs = parseIsoToMs(findText(block, "news:publication_date") || "") ?? fetchedAtMs;
      const summary = findText(block, "image:caption") || "";
      const keywords = extractKeywords(findText(block, "news:keywords") || "", loc);
      return { url: loc, source: REUTERS_SOURCE, title, summary, publishedAtMs, fetchedAtMs, keywords };
    })
    .filter((item): item is NewsItem => item !== null);
}

function findText(block: string, tag: string): string | null {
  const escaped = tag.replace(":", "\\:");
  const match = block.match(new RegExp(`<${escaped}[^>]*>([\\s\\S]*?)<\\/${escaped}>`));
  return match ? decodeXml(match[1].trim()) : null;
}

function decodeXml(value: string): string {
  const cdata = value.match(/^<!\[CDATA\[([\s\S]*)\]\]>$/);
  const text = cdata ? cdata[1] : value;
  return text.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}

function extractKeywords(raw: string, url: string): string[] {
  const cleaned = raw.split(",").map((x) => x.trim()).filter((x) => x && !x.startsWith("GUID:") && !x.includes("newsml_") && !x.includes("tag:reuters.com"));
  if (cleaned.length > 0) return cleaned;
  try {
    const segments = new URL(url).pathname.split("/").filter(Boolean);
    return segments.slice(0, -1).slice(0, 3);
  } catch {
    return [];
  }
}

function parseIsoToMs(value: string): number | null {
  const ts = Date.parse(value);
  return Number.isFinite(ts) ? ts : null;
}
