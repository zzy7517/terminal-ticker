/**
 * Jin10 Flash (快讯) provider.
 *
 * Calls `list_flash` and `search_flash` via the MCP bridge.
 * Converts results into NewsItem for the shared news store.
 */
import type { NewsItem } from "../news/types.js";
import type { Jin10FlashItem } from "./types.js";

export const JIN10_SOURCE = "jin10";

/**
 * Parse the raw MCP response from `list_flash` into Jin10FlashItem[].
 */
export function parseFlashResponse(raw: unknown): Jin10FlashItem[] {
  if (!raw || typeof raw !== "object") return [];

  // Handle structuredContent vs plain content
  const data = extractData(raw);
  if (!data) return [];

  const items = Array.isArray(data) ? data : (data as Record<string, unknown>).items;
  if (!Array.isArray(items)) return [];

  return items.map((item: Record<string, unknown>) => {
    // Derive a stable id: prefer explicit id/flash_id, then extract from url, then hash time+content
    let id = String(item.id ?? item.flash_id ?? "");
    if (!id && typeof item.url === "string") {
      // url like "https://flash.jin10.com/detail/20260525134457305800" → extract trailing id
      const match = item.url.match(/\/([^/]+)$/);
      if (match) id = match[1];
    }
    if (!id) {
      // Fallback: use time + first 20 chars of content as fingerprint
      id = `${String(item.time ?? "")}_${String(item.content ?? "").slice(0, 20)}`;
    }
    return {
      id,
      content: String(item.content ?? item.title ?? ""),
      time: String(item.time ?? item.pub_time ?? ""),
      important: Boolean(item.important ?? (Number(item.star ?? item.type ?? 0) >= 2)),
      type: item.type != null ? String(item.type) : undefined,
      raw: item,
    };
  }).filter((item) => item.content.trim());
}

/**
 * Extract pagination cursor from response.
 */
export function extractNextCursor(raw: unknown): string | null {
  if (!raw || typeof raw !== "object") return null;
  const data = extractData(raw);
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const cursor = (data as Record<string, unknown>).next_cursor;
  return cursor ? String(cursor) : null;
}

/**
 * Convert Jin10FlashItem[] to NewsItem[] for the news store.
 */
export function flashToNewsItems(flashes: Jin10FlashItem[]): NewsItem[] {
  const now = Date.now();
  return flashes.map((flash) => {
    const publishedAtMs = parseTimestamp(flash.time) ?? now;
    // Use the real jin10 URL if available, otherwise synthetic
    const url = flash.raw.url && typeof flash.raw.url === "string"
      ? flash.raw.url
      : `jin10://flash/${flash.id}`;
    return {
      url,
      source: JIN10_SOURCE,
      title: flash.content,
      summary: flash.important ? "[重要] " + flash.content : "",
      publishedAtMs,
      fetchedAtMs: now,
      keywords: flash.important ? ["important"] : [],
    };
  });
}

// ── Internal helpers ──────────────────────────────────────────────────────────

function extractData(raw: unknown): unknown {
  const obj = raw as Record<string, unknown>;
  // MCP structured response: check for data field
  if (obj.data !== undefined) return obj.data;
  // Some responses wrap in result.structuredContent.data
  if (obj.result && typeof obj.result === "object") {
    const result = obj.result as Record<string, unknown>;
    if (result.structuredContent && typeof result.structuredContent === "object") {
      return (result.structuredContent as Record<string, unknown>).data ?? result.structuredContent;
    }
    return result.data ?? result;
  }
  // Direct items array
  if (obj.items) return obj;
  return obj;
}

function parseTimestamp(value: string): number | null {
  if (!value) return null;
  const ts = Date.parse(value);
  return Number.isFinite(ts) ? ts : null;
}
