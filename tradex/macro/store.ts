/**
 * Macro data layer — SQLite persistence.
 *
 * File: ~/.cache/tradex/macro.sqlite3
 *
 * Three tables:
 *  - `macro_points`      numeric observations, keyed by (series, period, vintage)
 *  - `macro_series_meta` per-series fetch bookkeeping
 *  - `macro_events`      calendar releases, keyed by (normalized title, instant)
 *
 * NOTE on the vintage sentinel: SQLite treats NULLs as distinct in UNIQUE
 * indexes, so a nullable `vintage_ts` in the primary key would let every poll
 * insert a duplicate row for real-time sources. We therefore store 0 for
 * "no vintage" and translate to/from null at this boundary.
 */

import path from "node:path";
import type { Database } from "better-sqlite3";
import { BaseStore, defaultCacheDir, nowMs } from "../db.js";
import type {
  MacroEvent,
  MacroEventImpact,
  MacroPoint,
  MacroSeriesMeta,
} from "./domain.js";

const DEFAULT_FILENAME = "macro.sqlite3";

/** Stored in place of NULL for sources that publish in real time. */
const NO_VINTAGE = 0;

interface PointRow {
  ts: number;
  value: number | null;
  vintage_ts: number;
}

interface EventRow {
  key: string;
  pub_time_ms: number;
  title: string;
  normalized_title: string;
  country: string | null;
  impact: string;
  star: number | null;
  previous: string | null;
  consensus: string | null;
  actual: string | null;
  revised: string | null;
  note: string | null;
  provider: string;
  fetched_at_ms: number;
}

export class MacroStore extends BaseStore {
  constructor(dbPath?: string) {
    super(dbPath ?? path.join(defaultCacheDir(), DEFAULT_FILENAME));
  }

  protected override initSchema(conn: Database): void {
    conn.exec(`
      CREATE TABLE IF NOT EXISTS macro_points (
        series_id  TEXT    NOT NULL,
        ts         INTEGER NOT NULL,
        value      REAL,
        vintage_ts INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (series_id, ts, vintage_ts)
      );
      CREATE INDEX IF NOT EXISTS idx_macro_points_series_ts
        ON macro_points(series_id, ts DESC);
      CREATE INDEX IF NOT EXISTS idx_macro_points_vintage
        ON macro_points(series_id, vintage_ts);

      CREATE TABLE IF NOT EXISTS macro_series_meta (
        series_id        TEXT PRIMARY KEY,
        source           TEXT    NOT NULL,
        source_series_id TEXT    NOT NULL,
        label            TEXT    NOT NULL,
        category         TEXT    NOT NULL,
        unit             TEXT,
        cadence_seconds  INTEGER NOT NULL,
        vintaged         INTEGER NOT NULL,
        last_fetched_at  INTEGER,
        last_error       TEXT
      );

      CREATE TABLE IF NOT EXISTS macro_events (
        key              TEXT PRIMARY KEY,
        pub_time_ms      INTEGER NOT NULL,
        title            TEXT    NOT NULL,
        normalized_title TEXT    NOT NULL,
        country          TEXT,
        impact           TEXT    NOT NULL,
        star             INTEGER,
        previous         TEXT,
        consensus        TEXT,
        actual           TEXT,
        revised          TEXT,
        note             TEXT,
        provider         TEXT    NOT NULL,
        fetched_at_ms    INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_macro_events_time
        ON macro_events(pub_time_ms);
      CREATE INDEX IF NOT EXISTS idx_macro_events_impact_time
        ON macro_events(impact, pub_time_ms);
    `);
  }

  // ── Series metadata ─────────────────────────────────────────────────────────

  /** Register (or refresh) series metadata. Idempotent. */
  upsertSeriesMeta(series: MacroSeriesMeta[]): void {
    const conn = this.getConn();
    const stmt = conn.prepare(`
      INSERT INTO macro_series_meta
        (series_id, source, source_series_id, label, category, unit, cadence_seconds, vintaged)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(series_id) DO UPDATE SET
        source = excluded.source,
        source_series_id = excluded.source_series_id,
        label = excluded.label,
        category = excluded.category,
        unit = excluded.unit,
        cadence_seconds = excluded.cadence_seconds,
        vintaged = excluded.vintaged
    `);
    const run = conn.transaction((items: MacroSeriesMeta[]) => {
      for (const s of items) {
        stmt.run(
          s.seriesId,
          s.source,
          s.sourceSeriesId,
          s.label,
          s.category,
          s.unit,
          s.cadenceSeconds,
          s.vintaged ? 1 : 0,
        );
      }
    });
    run(series);
  }

  recordFetchResult(seriesId: string, error: string | null): void {
    const conn = this.getConn();
    conn.prepare(`
      UPDATE macro_series_meta SET last_fetched_at = ?, last_error = ? WHERE series_id = ?
    `).run(nowMs(), error, seriesId);
  }

  getFetchBookkeeping(seriesId: string): { lastFetchedAtMs: number | null; lastError: string | null } {
    const conn = this.getConn();
    const row = conn.prepare(`
      SELECT last_fetched_at, last_error FROM macro_series_meta WHERE series_id = ?
    `).get(seriesId) as { last_fetched_at: number | null; last_error: string | null } | undefined;
    return {
      lastFetchedAtMs: row?.last_fetched_at ?? null,
      lastError: row?.last_error ?? null,
    };
  }

  // ── Points ──────────────────────────────────────────────────────────────────

  /**
   * Insert or replace observations. A revised value for an already-stored
   * (series, period) arrives as a new row because its vintage differs, so
   * revision history accumulates rather than overwriting.
   */
  upsertPoints(points: MacroPoint[]): number {
    if (points.length === 0) return 0;
    const conn = this.getConn();
    const stmt = conn.prepare(`
      INSERT INTO macro_points (series_id, ts, value, vintage_ts)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(series_id, ts, vintage_ts) DO UPDATE SET value = excluded.value
    `);
    const run = conn.transaction((items: MacroPoint[]) => {
      for (const p of items) {
        stmt.run(p.seriesId, p.ts, p.value, p.vintageTs ?? NO_VINTAGE);
      }
    });
    run(points);
    return points.length;
  }

  /**
   * Read a series as it was known at `asOfMs`.
   *
   * For each period only the latest vintage published at or before `asOfMs` is
   * returned, so a backtest can never observe a value before its release or see
   * a revision that had not yet happened.
   *
   * `asOfMs` defaults to now, which is what live callers want.
   */
  getSeries(
    seriesId: string,
    options: { asOfMs?: number; fromMs?: number; limit?: number } = {},
  ): MacroPoint[] {
    const conn = this.getConn();
    const asOf = options.asOfMs ?? nowMs();
    const from = options.fromMs ?? 0;
    const limit = options.limit ?? 5000;

    // COALESCE folds the sentinel back into "published at its period", which is
    // exactly the semantics of a real-time source.
    const rows = conn.prepare(`
      SELECT ts, value, vintage_ts FROM (
        SELECT ts, value, vintage_ts,
               ROW_NUMBER() OVER (
                 PARTITION BY ts
                 ORDER BY vintage_ts DESC
               ) AS rn
        FROM macro_points
        WHERE series_id = @seriesId
          AND ts >= @from
          AND (CASE WHEN vintage_ts = 0 THEN ts ELSE vintage_ts END) <= @asOf
      )
      WHERE rn = 1
      ORDER BY ts DESC
      LIMIT @limit
    `).all({ seriesId, from, asOf, limit }) as PointRow[];

    return rows.map((r) => ({
      seriesId,
      ts: r.ts,
      value: r.value,
      vintageTs: r.vintage_ts === NO_VINTAGE ? null : r.vintage_ts,
    }));
  }

  /** Most recent observation known at `asOfMs`, skipping missing values. */
  getLatest(seriesId: string, asOfMs?: number): MacroPoint | null {
    const points = this.getSeries(seriesId, { asOfMs, limit: 32 });
    return points.find((p) => p.value !== null) ?? null;
  }

  countPoints(seriesId: string): number {
    const conn = this.getConn();
    const row = conn.prepare(`
      SELECT COUNT(*) AS n FROM macro_points WHERE series_id = ?
    `).get(seriesId) as { n: number };
    return row.n;
  }

  // ── Calendar events ─────────────────────────────────────────────────────────

  /**
   * Persist calendar events.
   *
   * Conflicts on `key` update in place, which is how a release transitions from
   * "scheduled, consensus only" to "published, actual filled in". Fields are
   * only overwritten when the incoming event actually carries a value, so a
   * provider that omits `star` cannot erase a richer provider's grading.
   */
  upsertEvents(events: MacroEvent[]): number {
    if (events.length === 0) return 0;
    const conn = this.getConn();
    const stmt = conn.prepare(`
      INSERT INTO macro_events
        (key, pub_time_ms, title, normalized_title, country, impact, star,
         previous, consensus, actual, revised, note, provider, fetched_at_ms)
      VALUES
        (@key, @pubTimeMs, @title, @normalizedTitle, @country, @impact, @star,
         @previous, @consensus, @actual, @revised, @note, @provider, @fetchedAtMs)
      ON CONFLICT(key) DO UPDATE SET
        title         = excluded.title,
        country       = COALESCE(excluded.country, country),
        impact        = excluded.impact,
        star          = COALESCE(excluded.star, star),
        previous      = COALESCE(excluded.previous, previous),
        consensus     = COALESCE(excluded.consensus, consensus),
        actual        = COALESCE(excluded.actual, actual),
        revised       = COALESCE(excluded.revised, revised),
        note          = COALESCE(excluded.note, note),
        provider      = excluded.provider,
        fetched_at_ms = excluded.fetched_at_ms
    `);
    const run = conn.transaction((items: MacroEvent[]) => {
      for (const e of items) {
        stmt.run({
          key: e.key,
          pubTimeMs: e.pubTimeMs,
          title: e.title,
          normalizedTitle: e.normalizedTitle,
          country: e.country,
          impact: e.impact,
          star: e.star,
          previous: e.previous,
          consensus: e.consensus,
          actual: e.actual,
          revised: e.revised,
          note: e.note,
          provider: e.provider,
          fetchedAtMs: e.fetchedAtMs,
        });
      }
    });
    run(events);
    return events.length;
  }

  /** Events whose publication instant falls in [fromMs, toMs]. */
  getEvents(options: {
    fromMs: number;
    toMs: number;
    minImpact?: MacroEventImpact;
  }): MacroEvent[] {
    const conn = this.getConn();
    const allowed = impactsAtLeast(options.minImpact ?? "low");
    const placeholders = allowed.map(() => "?").join(", ");
    const rows = conn.prepare(`
      SELECT * FROM macro_events
      WHERE pub_time_ms >= ? AND pub_time_ms <= ?
        AND impact IN (${placeholders})
      ORDER BY pub_time_ms ASC
    `).all(options.fromMs, options.toMs, ...allowed) as EventRow[];
    return rows.map(rowToEvent);
  }

  countEvents(): number {
    const conn = this.getConn();
    const row = conn.prepare(`SELECT COUNT(*) AS n FROM macro_events`).get() as { n: number };
    return row.n;
  }

  eventProviders(): string[] {
    const conn = this.getConn();
    const rows = conn.prepare(
      `SELECT DISTINCT provider FROM macro_events ORDER BY provider`,
    ).all() as Array<{ provider: string }>;
    return rows.map((r) => r.provider);
  }

  eventBookkeeping(): { lastFetchedAtMs: number | null } {
    const conn = this.getConn();
    const row = conn.prepare(
      `SELECT MAX(fetched_at_ms) AS last FROM macro_events`,
    ).get() as { last: number | null };
    return { lastFetchedAtMs: row.last ?? null };
  }

  /** Drop events older than `beforeMs`, keeping the table bounded. */
  pruneEvents(beforeMs: number): number {
    const conn = this.getConn();
    const info = conn.prepare(`DELETE FROM macro_events WHERE pub_time_ms < ?`).run(beforeMs);
    return info.changes;
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const IMPACT_ORDER: MacroEventImpact[] = ["low", "medium", "high"];

/** Impact levels at or above `min`, for SQL `IN (...)` filtering. */
export function impactsAtLeast(min: MacroEventImpact): MacroEventImpact[] {
  const idx = IMPACT_ORDER.indexOf(min);
  return IMPACT_ORDER.slice(idx < 0 ? 0 : idx);
}

function rowToEvent(row: EventRow): MacroEvent {
  return {
    key: row.key,
    pubTimeMs: row.pub_time_ms,
    title: row.title,
    normalizedTitle: row.normalized_title,
    country: row.country,
    impact: (IMPACT_ORDER as string[]).includes(row.impact)
      ? (row.impact as MacroEventImpact)
      : "low",
    star: row.star,
    previous: row.previous,
    consensus: row.consensus,
    actual: row.actual,
    revised: row.revised,
    note: row.note,
    provider: row.provider,
    fetchedAtMs: row.fetched_at_ms,
  };
}
