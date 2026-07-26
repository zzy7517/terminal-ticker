/**
 * Calendar normalization and event-window evaluation.
 *
 * Provider-agnostic: everything here operates on {@link MacroEvent}, so adding
 * a second calendar source never touches this file.
 */

import type {
  EventWindowConfig,
  EventWindowVerdict,
  MacroEvent,
  MacroEventImpact,
} from "./domain.js";

/**
 * Collapse a title to a dedup-friendly form: lowercase, punctuation and
 * whitespace stripped.
 *
 * Scope note: this reliably deduplicates *within* a provider (repeated polls of
 * the same release). It does NOT deduplicate across languages — Jin10's
 * "美国6月CPI年率" and Finnhub's "CPI YoY" normalize differently and will be
 * stored as two events. That is acceptable: event-window evaluation is
 * idempotent, so a duplicate at the same instant produces the same verdict. It
 * only matters for display, where a provider preference should be applied.
 */
export function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[\s　]+/g, "")
    .replace(/[()（）[\]【】:：,，.。%-/]+/g, "");
}

/** Stable event identity — see {@link MacroEvent.key}. */
export function eventKey(normalizedTitle: string, pubTimeMs: number): string {
  return `${pubTimeMs}:${normalizedTitle}`;
}

/**
 * Parse a `YYYY-MM-DD HH:mm[:ss]` wall-clock string in a fixed UTC offset.
 *
 * Calendars publish local wall-clock time with no offset marker, so the offset
 * must be supplied by the provider adapter. Getting this wrong shifts every
 * silence window by whole hours, which is why there is no "assume local time"
 * fallback here — an unparseable input returns null and the event is dropped.
 */
export function parseWallClock(input: string, utcOffsetHours: number): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/.exec(input.trim());
  if (!match) return null;
  const [, y, mo, d, h, mi, s] = match;
  const ms = Date.UTC(
    Number(y),
    Number(mo) - 1,
    Number(d),
    Number(h) - utcOffsetHours,
    Number(mi),
    s ? Number(s) : 0,
  );
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Map a 1-5 star grading to the three-level common denominator.
 *
 * 4+ is treated as high, matching the existing `get_economic_calendar` agent
 * tool which surfaces `star >= 4`.
 */
export function starToImpact(star: number | null): MacroEventImpact {
  if (star === null || !Number.isFinite(star)) return "low";
  if (star >= 4) return "high";
  if (star === 3) return "medium";
  return "low";
}

/** Blank-ish provider strings become null so COALESCE upserts behave. */
export function nullIfBlank(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed === "-" || trimmed === "--") return null;
  return trimmed;
}

const IMPACT_RANK: Record<MacroEventImpact, number> = { low: 0, medium: 1, high: 2 };

/**
 * Decide whether `atMs` falls inside a release's silence window.
 *
 * `events` must already be filtered to the surrounding time range; pass the
 * result of `MacroStore.getEvents`.
 *
 * Fail-closed contract: when `events` is null the calendar could not be
 * consulted and the verdict is `{ inWindow: true, unknown: true }`. An empty
 * array means "consulted, nothing scheduled" and yields `inWindow: false`.
 * Callers must distinguish these — treating unknown as safe is what allowed
 * trading straight through a CPI print before this module existed.
 */
export function evaluateEventWindow(
  events: MacroEvent[] | null,
  atMs: number,
  config: EventWindowConfig,
): EventWindowVerdict {
  if (events === null) {
    return { inWindow: true, event: null, unknown: true };
  }

  const minRank = IMPACT_RANK[config.minImpact];
  const beforeMs = config.beforeMinutes * 60_000;
  const afterMs = config.afterMinutes * 60_000;

  for (const event of events) {
    if (IMPACT_RANK[event.impact] < minRank) continue;
    if (atMs >= event.pubTimeMs - beforeMs && atMs <= event.pubTimeMs + afterMs) {
      return { inWindow: true, event, unknown: false };
    }
  }

  return { inWindow: false, event: null, unknown: false };
}
