/**
 * Forex Factory economic calendar provider.
 *
 * Uses the public weekly JSON feed hosted on nfs.faireconomy.media (no login).
 * Not an official API — treat as best-effort and tolerate rate limits.
 */

import { nowMs } from "../../db.js";
import type { MacroCalendarProvider, MacroEvent, MacroEventImpact } from "../domain.js";
import { eventKey, normalizeTitle, nullIfBlank } from "../calendar.js";

export const FOREXFACTORY_CALENDAR_SOURCE = "forexfactory";
export const DEFAULT_FF_CALENDAR_URL = "https://nfs.faireconomy.media/ff_calendar_thisweek.json";

export interface ForexFactoryCalendarRow {
  title?: unknown;
  country?: unknown;
  date?: unknown;
  impact?: unknown;
  forecast?: unknown;
  previous?: unknown;
  actual?: unknown;
  revised?: unknown;
}

export class ForexFactoryCalendarProvider implements MacroCalendarProvider {
  readonly name = FOREXFACTORY_CALENDAR_SOURCE;
  readonly url: string;
  readonly timeoutSeconds: number;
  private readonly enabled: boolean;

  constructor(input: { enabled?: boolean; url?: string; timeoutSeconds?: number } = {}) {
    this.enabled = input.enabled ?? true;
    this.url = input.url ?? DEFAULT_FF_CALENDAR_URL;
    this.timeoutSeconds = input.timeoutSeconds ?? 15;
  }

  get available(): boolean {
    return this.enabled;
  }

  async fetchEvents(): Promise<MacroEvent[]> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutSeconds * 1000);
    try {
      const response = await fetch(this.url, {
        headers: {
          Accept: "application/json",
          "User-Agent": "tradex-macro/1.0 (+forexfactory-calendar)",
        },
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const raw = (await response.json()) as unknown;
      if (!Array.isArray(raw)) {
        throw new Error("unexpected calendar payload (not an array)");
      }
      return mapForexFactoryCalendarRows(raw as ForexFactoryCalendarRow[]);
    } finally {
      clearTimeout(timer);
    }
  }
}

export function mapForexFactoryCalendarRows(
  rows: ForexFactoryCalendarRow[],
  fetchedAtMs = nowMs(),
): MacroEvent[] {
  const events: MacroEvent[] = [];

  for (const row of rows) {
    const title = typeof row.title === "string" ? row.title.trim() : "";
    if (!title) continue;

    const dateRaw = typeof row.date === "string" ? row.date.trim() : "";
    const pubTimeMs = Date.parse(dateRaw);
    if (!Number.isFinite(pubTimeMs)) continue;

    const impact = mapImpact(typeof row.impact === "string" ? row.impact : "");
    const normalizedTitle = normalizeTitle(title);

    events.push({
      key: eventKey(normalizedTitle, pubTimeMs),
      pubTimeMs,
      title,
      normalizedTitle,
      country: nullIfBlank(typeof row.country === "string" ? row.country : null),
      impact,
      // FF only grades three levels; a fabricated 1-5 number would be
      // indistinguishable from Jin10's real granularity downstream (star
      // filters, star icons). store.ts's COALESCE(excluded.star, star) is
      // built to accept this null without erasing a richer provider's rating.
      star: null,
      previous: nullIfBlank(typeof row.previous === "string" ? row.previous : null),
      consensus: nullIfBlank(typeof row.forecast === "string" ? row.forecast : null),
      actual: nullIfBlank(typeof row.actual === "string" ? row.actual : null),
      revised: nullIfBlank(typeof row.revised === "string" ? row.revised : null),
      note: null,
      provider: FOREXFACTORY_CALENDAR_SOURCE,
      fetchedAtMs,
    });
  }

  return events;
}

function mapImpact(raw: string): MacroEventImpact {
  const value = raw.trim().toLowerCase();
  if (value === "high") return "high";
  if (value === "medium" || value === "med") return "medium";
  return "low";
}
