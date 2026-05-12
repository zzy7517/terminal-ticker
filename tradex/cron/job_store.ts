import Database from "better-sqlite3";
import { BaseStore, defaultCacheDir, jsonDumps, jsonLoads, nowMs } from "../db.js";
import type { CronJobConfig } from "../config/index.js";
import path from "node:path";

export const DEFAULT_CRON_DB_FILENAME = "cron.sqlite3";

export function defaultCronDbPath(): string {
  return path.join(defaultCacheDir(), DEFAULT_CRON_DB_FILENAME);
}

interface CronJobRow {
  name: string;
  cron: string;
  system_prompt: string;
  enabled: number;
  symbols_json: string;
  model: string | null;
  user_message: string;
  max_iterations: number | null;
  max_candles: number | null;
  trading_enabled: number;
  social_enabled: number;
  timezone: string | null;
  created_at_ms: number;
  updated_at_ms: number;
}

function rowToConfig(row: CronJobRow): CronJobConfig {
  const symbols = jsonLoads(row.symbols_json);
  return {
    name: row.name,
    cron: row.cron,
    systemPrompt: row.system_prompt,
    enabled: row.enabled === 1,
    symbols: Array.isArray(symbols) ? symbols.filter((s): s is string => typeof s === "string") : [],
    model: row.model,
    userMessage: row.user_message,
    maxIterations: row.max_iterations,
    maxCandles: row.max_candles,
    tradingEnabled: row.trading_enabled === 1,
    socialEnabled: row.social_enabled === 1,
    timezone: row.timezone,
  };
}

export class CronJobStore extends BaseStore {
  constructor(dbPath: string | null = null) {
    super(dbPath ?? defaultCronDbPath());
  }

  protected override initSchema(conn: Database.Database): void {
    conn.exec(`
      CREATE TABLE IF NOT EXISTS cron_jobs (
        name TEXT PRIMARY KEY,
        cron TEXT NOT NULL,
        system_prompt TEXT NOT NULL DEFAULT '',
        enabled INTEGER NOT NULL DEFAULT 1,
        symbols_json TEXT NOT NULL DEFAULT '[]',
        model TEXT,
        user_message TEXT NOT NULL DEFAULT '开始定时看盘分析',
        max_iterations INTEGER,
        max_candles INTEGER,
        trading_enabled INTEGER NOT NULL DEFAULT 0,
        social_enabled INTEGER NOT NULL DEFAULT 0,
        timezone TEXT,
        created_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL
      );
    `);
  }

  listAll(): CronJobConfig[] {
    const rows = this.getConn()
      .prepare("SELECT * FROM cron_jobs ORDER BY created_at_ms ASC")
      .all() as CronJobRow[];
    return rows.map(rowToConfig);
  }

  get(name: string): CronJobConfig | null {
    const row = this.getConn()
      .prepare("SELECT * FROM cron_jobs WHERE name = ?")
      .get(name) as CronJobRow | undefined;
    return row ? rowToConfig(row) : null;
  }

  upsert(job: CronJobConfig): void {
    const now = nowMs();
    this.getConn()
      .prepare(`
        INSERT INTO cron_jobs (name, cron, system_prompt, enabled, symbols_json, model,
          user_message, max_iterations, max_candles, trading_enabled, social_enabled,
          timezone, created_at_ms, updated_at_ms)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(name) DO UPDATE SET
          cron = excluded.cron,
          system_prompt = excluded.system_prompt,
          enabled = excluded.enabled,
          symbols_json = excluded.symbols_json,
          model = excluded.model,
          user_message = excluded.user_message,
          max_iterations = excluded.max_iterations,
          max_candles = excluded.max_candles,
          trading_enabled = excluded.trading_enabled,
          social_enabled = excluded.social_enabled,
          timezone = excluded.timezone,
          updated_at_ms = excluded.updated_at_ms
      `)
      .run(
        job.name,
        job.cron,
        job.systemPrompt,
        job.enabled ? 1 : 0,
        jsonDumps(job.symbols),
        job.model,
        job.userMessage,
        job.maxIterations,
        job.maxCandles,
        job.tradingEnabled ? 1 : 0,
        job.socialEnabled ? 1 : 0,
        job.timezone,
        now,
        now,
      );
  }

  remove(name: string): boolean {
    const result = this.getConn()
      .prepare("DELETE FROM cron_jobs WHERE name = ?")
      .run(name);
    return result.changes > 0;
  }

  setEnabled(name: string, enabled: boolean): void {
    const result = this.getConn()
      .prepare("UPDATE cron_jobs SET enabled = ?, updated_at_ms = ? WHERE name = ?")
      .run(enabled ? 1 : 0, nowMs(), name);
    if (result.changes === 0) throw new Error(`Cron job not found: ${name}`);
  }

  rename(oldName: string, newName: string): void {
    const now = nowMs();
    this.getConn()
      .prepare("UPDATE cron_jobs SET name = ?, updated_at_ms = ? WHERE name = ?")
      .run(newName, now, oldName);
  }

  isEmpty(): boolean {
    const row = this.getConn().prepare("SELECT COUNT(*) as cnt FROM cron_jobs").get() as { cnt: number };
    return row.cnt === 0;
  }

  importFromToml(jobs: CronJobConfig[]): number {
    let imported = 0;
    const tx = this.getConn().transaction((items: CronJobConfig[]) => {
      for (const job of items) {
        if (this.get(job.name)) continue;
        this.upsert(job);
        imported += 1;
      }
    });
    tx(jobs);
    return imported;
  }
}
