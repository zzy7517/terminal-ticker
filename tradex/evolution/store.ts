/**
 * EvolutionStore — SQLite persistence for scorecard, weights, recommendations.
 */

import Database from "better-sqlite3";
import { join } from "path";
import { homedir } from "os";
import { mkdirSync } from "fs";
import type { DarwinWeightEntry, ModuleScore, Recommendation, PromptModification } from "./types.js";
import { DEFAULT_MODULE_IDS, DEFAULT_DARWIN_WEIGHT } from "./types.js";

const DB_DIR = join(homedir(), ".cache", "tradex");
const DB_PATH = join(DB_DIR, "evolution.sqlite3");

export class EvolutionStore {
  private db: Database.Database;

  constructor(dbPath?: string) {
    mkdirSync(DB_DIR, { recursive: true });
    this.db = new Database(dbPath ?? DB_PATH);
    this.db.pragma("journal_mode = WAL");
    this.migrate();
    this.ensureDefaults();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS darwin_weights (
        module_id TEXT PRIMARY KEY,
        weight REAL NOT NULL DEFAULT 1.0,
        sharpe_30d REAL,
        hit_rate_30d REAL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS darwin_weight_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        module_id TEXT NOT NULL,
        weight REAL NOT NULL,
        sharpe_30d REAL,
        hit_rate_30d REAL,
        recorded_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_dwh_module_time
        ON darwin_weight_history(module_id, recorded_at DESC);

      CREATE TABLE IF NOT EXISTS recommendations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        module_id TEXT NOT NULL,
        instrument_key TEXT NOT NULL,
        signal TEXT NOT NULL,
        conviction INTEGER NOT NULL,
        price_at_recommendation REAL NOT NULL,
        recommended_at TEXT NOT NULL,
        return_1d REAL,
        return_5d REAL,
        return_20d REAL
      );

      CREATE INDEX IF NOT EXISTS idx_rec_module_time
        ON recommendations(module_id, recommended_at DESC);

      CREATE INDEX IF NOT EXISTS idx_rec_unfilled
        ON recommendations(return_5d) WHERE return_5d IS NULL;

      CREATE TABLE IF NOT EXISTS prompt_modifications (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        module_id TEXT NOT NULL,
        git_branch TEXT NOT NULL,
        description TEXT NOT NULL,
        before_sharpe REAL NOT NULL,
        after_sharpe REAL,
        status TEXT NOT NULL DEFAULT 'testing',
        created_at TEXT NOT NULL,
        evaluated_at TEXT
      );
    `);
  }

  private ensureDefaults(): void {
    const insert = this.db.prepare(`
      INSERT OR IGNORE INTO darwin_weights (module_id, weight, updated_at)
      VALUES (?, ?, ?)
    `);
    const now = new Date().toISOString();
    for (const id of DEFAULT_MODULE_IDS) {
      insert.run(id, DEFAULT_DARWIN_WEIGHT, now);
    }
  }

  // ─── Darwin Weights ────────────────────────────────────────────────────

  getDarwinWeights(): DarwinWeightEntry[] {
    const rows = this.db.prepare("SELECT * FROM darwin_weights").all() as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      moduleId: r.module_id as string,
      weight: r.weight as number,
      sharpe30d: (r.sharpe_30d as number) ?? null,
      hitRate30d: (r.hit_rate_30d as number) ?? null,
      updatedAt: r.updated_at as string,
    }));
  }

  updateDarwinWeight(moduleId: string, weight: number, sharpe: number | null, hitRate: number | null): void {
    const now = new Date().toISOString();
    this.db.prepare(`
      UPDATE darwin_weights SET weight = ?, sharpe_30d = ?, hit_rate_30d = ?, updated_at = ?
      WHERE module_id = ?
    `).run(weight, sharpe, hitRate, now, moduleId);

    // Append to history
    this.db.prepare(`
      INSERT INTO darwin_weight_history (module_id, weight, sharpe_30d, hit_rate_30d, recorded_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(moduleId, weight, sharpe, hitRate, now);
  }

  getWeightHistory(moduleId: string, limit = 90): DarwinWeightEntry[] {
    const rows = this.db.prepare(
      "SELECT * FROM darwin_weight_history WHERE module_id = ? ORDER BY recorded_at DESC LIMIT ?"
    ).all(moduleId, limit) as Array<Record<string, unknown>>;
    return rows.reverse().map((r) => ({
      moduleId: r.module_id as string,
      weight: r.weight as number,
      sharpe30d: (r.sharpe_30d as number) ?? null,
      hitRate30d: (r.hit_rate_30d as number) ?? null,
      updatedAt: r.recorded_at as string,
    }));
  }

  // ─── Recommendations ───────────────────────────────────────────────────

  insertRecommendation(rec: Recommendation): void {
    this.db.prepare(`
      INSERT INTO recommendations (module_id, instrument_key, signal, conviction, price_at_recommendation, recommended_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(rec.moduleId, rec.instrumentKey, rec.signal, rec.conviction, rec.priceAtRecommendation, rec.recommendedAt);
  }

  getUnfilledRecommendations(field: "return_1d" | "return_5d" | "return_20d", limit = 200): Recommendation[] {
    const rows = this.db.prepare(
      `SELECT * FROM recommendations WHERE ${field} IS NULL ORDER BY recommended_at ASC LIMIT ?`
    ).all(limit) as Array<Record<string, unknown>>;
    return rows.map((r) => this.deserializeRec(r));
  }

  updateReturn(id: number, field: "return_1d" | "return_5d" | "return_20d", value: number): void {
    this.db.prepare(`UPDATE recommendations SET ${field} = ? WHERE id = ?`).run(value, id);
  }

  getModuleRecommendations(moduleId: string, days = 30): Recommendation[] {
    const cutoff = new Date(Date.now() - days * 86400_000).toISOString();
    const rows = this.db.prepare(
      "SELECT * FROM recommendations WHERE module_id = ? AND recommended_at >= ? ORDER BY recommended_at DESC"
    ).all(moduleId, cutoff) as Array<Record<string, unknown>>;
    return rows.map((r) => this.deserializeRec(r));
  }

  // ─── Prompt Modifications ──────────────────────────────────────────────

  insertModification(mod: PromptModification): number {
    const result = this.db.prepare(`
      INSERT INTO prompt_modifications (module_id, git_branch, description, before_sharpe, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(mod.moduleId, mod.gitBranch, mod.description, mod.beforeSharpe, mod.status, mod.createdAt);
    return result.lastInsertRowid as number;
  }

  listModifications(limit = 50): PromptModification[] {
    const rows = this.db.prepare(
      "SELECT * FROM prompt_modifications ORDER BY created_at DESC LIMIT ?"
    ).all(limit) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: r.id as number,
      moduleId: r.module_id as string,
      gitBranch: r.git_branch as string,
      description: r.description as string,
      beforeSharpe: r.before_sharpe as number,
      afterSharpe: (r.after_sharpe as number) ?? null,
      status: r.status as PromptModification["status"],
      createdAt: r.created_at as string,
      evaluatedAt: (r.evaluated_at as string) ?? null,
    }));
  }

  private deserializeRec(r: Record<string, unknown>): Recommendation {
    return {
      id: r.id as number,
      moduleId: r.module_id as string,
      instrumentKey: r.instrument_key as string,
      signal: r.signal as Recommendation["signal"],
      conviction: r.conviction as number,
      priceAtRecommendation: r.price_at_recommendation as number,
      recommendedAt: r.recommended_at as string,
      return1d: (r.return_1d as number) ?? null,
      return5d: (r.return_5d as number) ?? null,
      return20d: (r.return_20d as number) ?? null,
    };
  }
}
