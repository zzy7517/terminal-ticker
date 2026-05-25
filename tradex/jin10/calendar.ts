/**
 * Jin10 Calendar (财经日历) provider.
 *
 * Calls `list_calendar` via MCP bridge.
 */
import type { Jin10CalendarEvent } from "./types.js";

/**
 * Parse raw MCP response from `list_calendar` into Jin10CalendarEvent[].
 */
export function parseCalendarResponse(raw: unknown): Jin10CalendarEvent[] {
  if (!raw || typeof raw !== "object") return [];

  const data = extractData(raw);
  const items = Array.isArray(data) ? data : null;
  if (!items) return [];

  return items.map((item: Record<string, unknown>) => ({
    pubTime: String(item.pub_time ?? item.time ?? ""),
    star: Number(item.star ?? 0),
    title: String(item.title ?? item.name ?? ""),
    country: item.country != null ? String(item.country) : undefined,
    previous: String(item.previous ?? item.fore ?? ""),
    consensus: String(item.consensus ?? item.expected ?? ""),
    actual: String(item.actual ?? ""),
    revised: String(item.revised ?? ""),
    affectTxt: String(item.affect_txt ?? item.affect ?? ""),
    raw: item,
  })).filter((event) => event.title.trim());
}

// ── Internal helpers ──────────────────────────────────────────────────────────

function extractData(raw: unknown): unknown {
  const obj = raw as Record<string, unknown>;
  if (obj.data !== undefined) {
    const data = obj.data;
    // data can be { items: [...] } or directly an array
    if (Array.isArray(data)) return data;
    if (data && typeof data === "object" && Array.isArray((data as Record<string, unknown>).items)) {
      return (data as Record<string, unknown>).items;
    }
    return data;
  }
  if (obj.result && typeof obj.result === "object") {
    const result = obj.result as Record<string, unknown>;
    if (result.structuredContent && typeof result.structuredContent === "object") {
      const sc = result.structuredContent as Record<string, unknown>;
      return sc.data ?? sc;
    }
    return result.data ?? result;
  }
  if (Array.isArray(obj.items)) return obj.items;
  return null;
}
