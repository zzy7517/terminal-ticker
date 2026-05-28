/**
 * PipelineStore — persists pipeline run history to SQLite.
 */

import Database from "better-sqlite3";
import { join } from "path";
import { homedir } from "os";
import { mkdirSync } from "fs";
import type { PipelineRun } from "./types.js";

const DB_DIR = join(homedir(), ".cache", "tradex");
const DB_PATH = join(DB_DIR, "pipeline.sqlite3");

export class PipelineStore {
  private db: Database.Database;

  constructor(dbPath?: string) {
    mkdirSync(DB_DIR, { recursive: true });
    this.db = new Database(dbPath ?? DB_PATH);
    this.db.pragma("journal_mode = WAL");
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS pipeline_runs (
        id TEXT PRIMARY KEY,
        triggered_by TEXT NOT NULL,
        instrument_key TEXT NOT NULL,
        regime_json TEXT NOT NULL,
        started_at TEXT NOT NULL,
        completed_at TEXT,
        status TEXT NOT NULL,
        module_results_json TEXT,
        decision_json TEXT,
        total_tokens INTEGER DEFAULT 0,
        total_cost_usd REAL DEFAULT 0,
        duration_ms INTEGER DEFAULT 0
      );

      CREATE INDEX IF NOT EXISTS idx_pipeline_runs_instrument
        ON pipeline_runs(instrument_key, started_at DESC);

      CREATE INDEX IF NOT EXISTS idx_pipeline_runs_status
        ON pipeline_runs(status, started_at DESC);
    `);
  }

  insert(run: PipelineRun): void {
    this.db.prepare(`
      INSERT INTO pipeline_runs
        (id, triggered_by, instrument_key, regime_json, started_at, completed_at, status, module_results_json, decision_json, total_tokens, total_cost_usd, duration_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      run.id,
      run.triggeredBy,
      run.instrumentKey,
      JSON.stringify(run.regime),
      run.startedAt,
      run.completedAt,
      run.status,
      JSON.stringify(run.moduleResults),
      run.decision ? JSON.stringify(run.decision) : null,
      run.totalTokens,
      run.totalCostUsd,
      run.durationMs,
    );
  }

  listRuns(opts: { instrumentKey?: string; limit?: number; offset?: number } = {}): PipelineRun[] {
    const limit = opts.limit ?? 50;
    const offset = opts.offset ?? 0;
    let query = "SELECT * FROM pipeline_runs";
    const params: unknown[] = [];

    if (opts.instrumentKey) {
      query += " WHERE instrument_key = ?";
      params.push(opts.instrumentKey);
    }
    query += " ORDER BY started_at DESC LIMIT ? OFFSET ?";
    params.push(limit, offset);

    const rows = this.db.prepare(query).all(...params) as Array<Record<string, unknown>>;
    return rows.map((row) => this.deserialize(row));
  }

  getRun(id: string): PipelineRun | null {
    const row = this.db.prepare("SELECT * FROM pipeline_runs WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    if (!row) return null;
    return this.deserialize(row);
  }

  sumCostSince(startedAtIso: string): number {
    const row = this.db.prepare(
      "SELECT COALESCE(SUM(total_cost_usd), 0) AS total FROM pipeline_runs WHERE started_at >= ? AND status = 'completed'"
    ).get(startedAtIso) as { total?: number } | undefined;
    return Number(row?.total ?? 0);
  }

  private deserialize(row: Record<string, unknown>): PipelineRun {
    return {
      id: row.id as string,
      triggeredBy: row.triggered_by as PipelineRun["triggeredBy"],
      instrumentKey: row.instrument_key as string,
      regime: JSON.parse(row.regime_json as string),
      startedAt: row.started_at as string,
      completedAt: (row.completed_at as string) ?? null,
      status: row.status as PipelineRun["status"],
      moduleResults: row.module_results_json ? JSON.parse(row.module_results_json as string) : [],
      decision: row.decision_json ? JSON.parse(row.decision_json as string) : null,
      totalTokens: row.total_tokens as number,
      totalCostUsd: row.total_cost_usd as number,
      durationMs: row.duration_ms as number,
    };
  }
}
