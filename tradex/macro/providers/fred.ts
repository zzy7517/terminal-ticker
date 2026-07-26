/**
 * FRED provider (Federal Reserve Bank of St. Louis).
 *
 * Free, unmetered, ~800k series, stable series ids. The reason it is the
 * primary source is `realtime_start` — FRED serves the full revision history,
 * so we can record when each value became public instead of guessing.
 *
 * Docs: https://fred.stlouisfed.org/docs/api/fred/series_observations.html
 */

import type { MacroPoint, MacroSeriesMeta } from "../domain.js";

const FRED_BASE = "https://api.stlouisfed.org/fred/series/observations";

/** FRED encodes a missing observation as ".", not as an empty string or null. */
const MISSING = ".";

interface FredObservation {
  date: string;
  value: string;
  realtime_start?: string;
  realtime_end?: string;
}

interface FredResponse {
  observations?: FredObservation[];
  error_message?: string;
}

export class FredProvider {
  readonly name = "fred";
  private readonly apiKey: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey.trim();
  }

  get available(): boolean {
    return this.apiKey.length > 0;
  }

  /**
   * Fetch observations for one series.
   *
   * For vintaged series we request the full revision history
   * (`realtime_start=1776-07-04`, FRED's documented "all vintages" sentinel),
   * which makes each row carry the date its value was first published. For
   * non-vintaged series we take the default single latest vintage, since daily
   * market rates are not revised and the extra rows would be pure bloat.
   */
  async fetchSeries(meta: MacroSeriesMeta, observationStart: Date): Promise<MacroPoint[]> {
    if (!this.available) throw new Error("FRED API key is not configured");

    const params = new URLSearchParams({
      series_id: meta.sourceSeriesId,
      api_key: this.apiKey,
      file_type: "json",
      observation_start: isoDate(observationStart),
    });

    if (meta.vintaged) {
      // Ask for every vintage so `realtime_start` reflects true publication.
      params.set("realtime_start", "1776-07-04");
      params.set("realtime_end", "9999-12-31");
      params.set("output_type", "2"); // all observations, one row per vintage
    }

    const response = await fetch(`${FRED_BASE}?${params.toString()}`);
    if (!response.ok) {
      // FRED puts a useful reason in the body even on 4xx.
      const body = await response.text().catch(() => "");
      const detail = extractErrorMessage(body) ?? response.statusText;
      throw new Error(`FRED ${meta.sourceSeriesId} failed: ${response.status} ${detail}`);
    }

    const payload = (await response.json()) as FredResponse;
    if (payload.error_message) {
      throw new Error(`FRED ${meta.sourceSeriesId} failed: ${payload.error_message}`);
    }

    const observations = payload.observations ?? [];
    return observations
      .map((obs) => toPoint(meta, obs))
      .filter((p): p is MacroPoint => p !== null);
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function toPoint(meta: MacroSeriesMeta, obs: FredObservation): MacroPoint | null {
  const ts = parseFredDate(obs.date);
  if (ts === null) return null;

  const raw = (obs.value ?? "").trim();
  const value = raw === MISSING || raw === "" ? null : Number(raw);

  return {
    seriesId: meta.seriesId,
    ts,
    value: value !== null && Number.isFinite(value) ? value : null,
    vintageTs: meta.vintaged ? parseFredDate(obs.realtime_start) : null,
  };
}

/**
 * FRED dates are `YYYY-MM-DD` with no timezone. Anchor them to UTC midnight so
 * the same input always produces the same timestamp regardless of where this
 * runs — a local-timezone parse would shift period boundaries and, for vintaged
 * series, could move a publication across a day boundary.
 */
function parseFredDate(date: string | undefined): number | null {
  if (!date) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date.trim());
  if (!match) return null;
  const ms = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return Number.isFinite(ms) ? ms : null;
}

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function extractErrorMessage(body: string): string | null {
  try {
    const parsed = JSON.parse(body) as FredResponse;
    return parsed.error_message ?? null;
  } catch {
    return null;
  }
}
