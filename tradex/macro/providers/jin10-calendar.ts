/**
 * Jin10 calendar provider.
 *
 * Adapts the existing `Jin10Service` to the provider-agnostic
 * {@link MacroCalendarProvider} interface so the macro layer never depends on
 * Jin10's field shapes. When a second calendar (Finnhub / FMP) is added it
 * implements the same interface and the store, window logic, and API stay put.
 */

import { nowMs } from "../../db.js";
import type { Jin10Service } from "../../jin10/service.js";
import type { MacroCalendarProvider, MacroEvent } from "../domain.js";
import { eventKey, normalizeTitle, nullIfBlank, parseWallClock, starToImpact } from "../calendar.js";

/**
 * Jin10 reports calendar times as Beijing wall-clock with no offset marker.
 *
 * Verified against a known release: Jin10 lists the New Zealand June trade
 * balance at `2026-07-20 06:45`; that release is scheduled for 10:45 NZST
 * (UTC+12), which is 06:45 at UTC+8.
 */
const JIN10_UTC_OFFSET_HOURS = 8;

export class Jin10CalendarProvider implements MacroCalendarProvider {
  readonly name = "jin10";
  private readonly jin10: Jin10Service;

  constructor(jin10: Jin10Service) {
    this.jin10 = jin10;
  }

  get available(): boolean {
    return this.jin10.available && this.jin10.config.calendarEnabled;
  }

  async fetchEvents(): Promise<MacroEvent[]> {
    const result = await this.jin10.refreshCalendar();
    if (result.error) throw new Error(result.error);
    return this.mapEvents(this.jin10.getCalendar());
  }

  /**
   * Convert whatever the service currently holds, without triggering a fetch.
   * Used to seed the store from an already-warm poller.
   */
  mapCurrent(): MacroEvent[] {
    return this.mapEvents(this.jin10.getCalendar());
  }

  private mapEvents(raw: ReturnType<Jin10Service["getCalendar"]>): MacroEvent[] {
    const fetchedAtMs = nowMs();
    const events: MacroEvent[] = [];

    for (const item of raw) {
      const pubTimeMs = parseWallClock(item.pubTime, JIN10_UTC_OFFSET_HOURS);
      // Unparseable timestamps are dropped rather than guessed — a silence
      // window anchored to the wrong instant is worse than a missing event,
      // because the caller can detect "no events" but not "wrong events".
      if (pubTimeMs === null) continue;

      const title = item.title.trim();
      if (!title) continue;

      const normalizedTitle = normalizeTitle(title);
      const star = Number.isFinite(item.star) && item.star > 0 ? item.star : null;

      events.push({
        key: eventKey(normalizedTitle, pubTimeMs),
        pubTimeMs,
        title,
        normalizedTitle,
        country: nullIfBlank(item.country),
        impact: starToImpact(star),
        star,
        previous: nullIfBlank(item.previous),
        consensus: nullIfBlank(item.consensus),
        actual: nullIfBlank(item.actual),
        revised: nullIfBlank(item.revised),
        note: nullIfBlank(item.affectTxt),
        provider: this.name,
        fetchedAtMs,
      });
    }

    return events;
  }
}
