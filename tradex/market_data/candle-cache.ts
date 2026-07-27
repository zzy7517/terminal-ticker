import Database from "better-sqlite3";
import path from "node:path";
import { CacheConfig } from "../config/index.js";
import { BaseStore, defaultCacheDir, nowMs } from "../db.js";
import { Candle } from "../domain/price-action.js";

export const DEFAULT_CACHE_FILENAME = "candles.sqlite3";
const INTERVAL_SECONDS: Record<string, number> = {
  "1m": 60,
  "3m": 180,
  "5m": 300,
  "15m": 900,
  "30m": 1800,
  "1H": 3600,
  "4H": 14_400,
  "6H": 21_600,
  "12H": 43_200,
  "1D": 86_400,
  "3D": 259_200,
  "1W": 604_800,
  "1M": 2_678_400,
};
const DIRECT_WINDOW_CANDLE_LIMIT = 1000;

export interface CandleFetchPlan {
  afterOpenTimeMs: number | null;
  limit: number;
}

export function defaultCachePath(): string {
  return path.join(defaultCacheDir(), DEFAULT_CACHE_FILENAME);
}

export function retentionSecondsForWindow(interval: string, limit: number): number {
  return (INTERVAL_SECONDS[interval] ?? 60) * Math.max(1, limit);
}

export class CandleCache extends BaseStore {
  readonly retentionSeconds: number;

  constructor(dbPath: string, retentionSeconds = 86_400) {
    super(dbPath);
    this.retentionSeconds = retentionSeconds;
  }

  static fromConfig(config: CacheConfig): CandleCache {
    return new CandleCache(config.path || defaultCachePath(), config.candleRetentionSeconds);
  }

  protected override initSchema(conn: Database.Database): void {
    conn.exec(`
      CREATE TABLE IF NOT EXISTS candles (
        symbol_key TEXT NOT NULL,
        interval TEXT NOT NULL,
        open_time_ms INTEGER NOT NULL,
        open REAL NOT NULL,
        high REAL NOT NULL,
        low REAL NOT NULL,
        close REAL NOT NULL,
        volume REAL NOT NULL,
        fetched_at_ms INTEGER NOT NULL,
        PRIMARY KEY (symbol_key, interval, open_time_ms)
      );
      CREATE INDEX IF NOT EXISTS idx_candles_lookup
      ON candles (symbol_key, interval, open_time_ms);
    `);
  }

  prune(input: { nowMs?: number; retentionSeconds?: number | null; symbolKey?: string | null; interval?: string | null } = {}): number {
    const currentMs = input.nowMs ?? nowMs();
    const cutoffMs = currentMs - this.effectiveRetention(input.retentionSeconds ?? null) * 1000;
    const clauses = ["open_time_ms < ?"];
    const params: Array<string | number> = [cutoffMs];
    if (input.symbolKey) {
      clauses.push("symbol_key = ?");
      params.push(input.symbolKey);
    }
    if (input.interval) {
      clauses.push("interval = ?");
      params.push(input.interval);
    }
    return this.getConn().prepare(`DELETE FROM candles WHERE ${clauses.join(" AND ")}`).run(...params).changes;
  }

  upsert(candles: readonly Candle[], input: { interval: string; fetchedAtMs?: number | null }): number {
    if (candles.length === 0) return 0;
    const fetchedAtMs = input.fetchedAtMs ?? nowMs();
    const stmt = this.getConn().prepare(`
      INSERT INTO candles (symbol_key, interval, open_time_ms, open, high, low, close, volume, fetched_at_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(symbol_key, interval, open_time_ms) DO UPDATE SET
        open = excluded.open,
        high = excluded.high,
        low = excluded.low,
        close = excluded.close,
        volume = excluded.volume,
        fetched_at_ms = excluded.fetched_at_ms
    `);
    const tx = this.getConn().transaction((rows: readonly Candle[]) => {
      for (const candle of rows) {
        stmt.run(candle.symbolKey, input.interval, candle.openTimeMs, candle.open, candle.high, candle.low, candle.close, candle.volume, fetchedAtMs);
      }
    });
    tx(candles);
    return candles.length;
  }

  latestFetchedAtMs(symbolKey: string, interval: string, input: { nowMs?: number; retentionSeconds?: number | null } = {}): number | null {
    const currentMs = input.nowMs ?? nowMs();
    const cutoffMs = currentMs - this.effectiveRetention(input.retentionSeconds ?? null) * 1000;
    const row = this.getConn()
      .prepare(
        `SELECT fetched_at_ms AS fetchedAtMs
         FROM candles
         WHERE symbol_key = ? AND interval = ? AND open_time_ms >= ?
         ORDER BY open_time_ms DESC
         LIMIT 1`,
      )
      .get(symbolKey, interval, cutoffMs) as { fetchedAtMs?: number } | undefined;
    return row?.fetchedAtMs ?? null;
  }

  recent(symbolKey: string, interval: string, input: { limit: number; nowMs?: number; retentionSeconds?: number | null }): Candle[] {
    const currentMs = input.nowMs ?? nowMs();
    const cutoffMs = currentMs - this.effectiveRetention(input.retentionSeconds ?? null) * 1000;
    const rows = this.getConn()
      .prepare(
        `SELECT symbol_key AS symbolKey, open_time_ms AS openTimeMs, open, high, low, close, volume
         FROM candles
         WHERE symbol_key = ? AND interval = ? AND open_time_ms >= ?
         ORDER BY open_time_ms DESC
         LIMIT ?`,
      )
      .all(symbolKey, interval, cutoffMs, input.limit) as Array<{
      symbolKey: string;
      openTimeMs: number;
      open: number;
      high: number;
      low: number;
      close: number;
      volume: number;
    }>;
    return rows
      .reverse()
      .map(
        (row) =>
          new Candle({
            symbolKey: row.symbolKey,
            openTimeMs: row.openTimeMs,
            open: row.open,
            high: row.high,
            low: row.low,
            close: row.close,
            volume: row.volume,
          }),
      );
  }

  private effectiveRetention(requestedSeconds: number | null): number {
    return requestedSeconds === null ? this.retentionSeconds : Math.max(this.retentionSeconds, requestedSeconds);
  }
}

export async function cachedFetchCandles(input: {
  cache: CandleCache;
  symbolKey: string;
  interval: string;
  limit: number;
  fetcher: (args: { interval: string; limit: number; afterOpenTimeMs?: number | null }) => Promise<Candle[]>;
  nowMs?: number;
  minimumRetentionSeconds?: number | null;
  maxCacheAgeSeconds?: number | null;
}): Promise<Candle[]> {
  const currentMs = input.nowMs ?? nowMs();
  input.cache.prune({
    nowMs: currentMs,
    retentionSeconds: input.minimumRetentionSeconds ?? null,
    symbolKey: input.symbolKey,
    interval: input.interval,
  });
  let cached = input.cache.recent(input.symbolKey, input.interval, {
    limit: input.limit,
    nowMs: currentMs,
    retentionSeconds: input.minimumRetentionSeconds ?? null,
  });
  if (input.maxCacheAgeSeconds !== undefined && input.maxCacheAgeSeconds !== null) {
    const latestFetchedAtMs = input.cache.latestFetchedAtMs(input.symbolKey, input.interval, {
      nowMs: currentMs,
      retentionSeconds: input.minimumRetentionSeconds ?? null,
    });
    if (cached.length >= input.limit && latestFetchedAtMs !== null && currentMs - latestFetchedAtMs <= input.maxCacheAgeSeconds * 1000) {
      return cached;
    }
  }
  const plan = fetchPlan(cached.at(-1)?.openTimeMs ?? null, cached.length, input.interval, input.limit, currentMs);
  try {
    const fetched = await input.fetcher({ interval: input.interval, limit: plan.limit, afterOpenTimeMs: plan.afterOpenTimeMs });
    if (fetched.length > 0) input.cache.upsert(fetched, { interval: input.interval, fetchedAtMs: currentMs });
    cached = input.cache.recent(input.symbolKey, input.interval, {
      limit: input.limit,
      nowMs: currentMs,
      retentionSeconds: input.minimumRetentionSeconds ?? null,
    });
    return cached.length > 0 ? cached : fetched.slice(-input.limit);
  } catch (error) {
    cached = input.cache.recent(input.symbolKey, input.interval, {
      limit: input.limit,
      nowMs: currentMs,
      retentionSeconds: input.minimumRetentionSeconds ?? null,
    });
    if (cached.length > 0) return cached;
    throw error;
  }
}

function fetchPlan(latestOpenMs: number | null, cachedCount: number, interval: string, limit: number, currentMs: number): CandleFetchPlan {
  if (latestOpenMs === null || cachedCount < limit) return { afterOpenTimeMs: null, limit: Math.max(limit, DIRECT_WINDOW_CANDLE_LIMIT) };
  const intervalMs = (INTERVAL_SECONDS[interval] ?? 60) * 1000;
  const missing = Math.max(1, Math.floor((currentMs - latestOpenMs) / intervalMs) + 2);
  if (missing > DIRECT_WINDOW_CANDLE_LIMIT) return { afterOpenTimeMs: null, limit: Math.max(limit, DIRECT_WINDOW_CANDLE_LIMIT) };
  return { afterOpenTimeMs: Math.max(0, latestOpenMs - intervalMs), limit: missing };
}
