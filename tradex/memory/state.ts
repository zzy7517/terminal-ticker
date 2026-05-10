import Database from "better-sqlite3";
import { BaseStore, nowMs } from "../db.js";
import { memoryStatePath } from "./paths.js";

export interface MemorySource {
  id: number;
  sourceType: string;
  sourceKey: string;
  payloadJson: string;
  createdAtMs: number;
  updatedAtMs: number;
}

export class MemoryStateStore extends BaseStore {
  constructor(dbPath: string | null = null) {
    super(dbPath ?? memoryStatePath());
  }

  protected override initSchema(conn: Database.Database): void {
    conn.exec(`
      CREATE TABLE IF NOT EXISTS memory_sources (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source_type TEXT NOT NULL,
        source_key TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL,
        UNIQUE(source_type, source_key)
      );
      CREATE TABLE IF NOT EXISTS memory_usage (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        file_path TEXT NOT NULL,
        usage_kind TEXT NOT NULL,
        used_at_ms INTEGER NOT NULL
      );
    `);
  }

  enqueueSource(input: { sourceType: string; sourceKey: string; payloadJson: string }): number {
    const at = nowMs();
    const result = this.getConn()
      .prepare(
        `INSERT INTO memory_sources (source_type, source_key, payload_json, created_at_ms, updated_at_ms)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(source_type, source_key) DO UPDATE SET payload_json = excluded.payload_json, updated_at_ms = excluded.updated_at_ms`,
      )
      .run(input.sourceType, input.sourceKey, input.payloadJson, at, at);
    return Number(result.lastInsertRowid);
  }

  recordUsage(input: { filePath: string; usageKind: string }): void {
    this.getConn().prepare("INSERT INTO memory_usage (file_path, usage_kind, used_at_ms) VALUES (?, ?, ?)").run(input.filePath, input.usageKind, nowMs());
  }
}
