import Database from "better-sqlite3";
import path from "node:path";
import { BaseStore, defaultCacheDir } from "../db.js";
import type { SessionInfo } from "./session_manager.js";

export const DEFAULT_SESSION_INDEX_FILENAME = "session_index.sqlite3";

export interface SessionIndexRow {
  id: string;
  filePath: string;
  instrumentKey: string | null;
  title: string;
  provider: string;
  model: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  firstMessage: string;
}

function defaultSessionIndexPath(): string {
  return path.join(defaultCacheDir(), DEFAULT_SESSION_INDEX_FILENAME);
}

export class SessionIndex extends BaseStore {
  constructor(dbPath: string | null = null) {
    super(dbPath ?? defaultSessionIndexPath());
  }

  protected override initSchema(conn: Database.Database): void {
    conn.exec(`
      CREATE TABLE IF NOT EXISTS session_index (
        id TEXT PRIMARY KEY,
        file_path TEXT NOT NULL,
        instrument_key TEXT,
        title TEXT,
        provider TEXT NOT NULL DEFAULT '',
        model TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        message_count INTEGER NOT NULL DEFAULT 0,
        first_message TEXT NOT NULL DEFAULT ''
      );
      CREATE INDEX IF NOT EXISTS idx_session_index_updated ON session_index (updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_session_index_instrument ON session_index (instrument_key, updated_at DESC);
    `);
  }

  upsert(info: SessionInfo): void {
    this.getConn()
      .prepare(
        `INSERT INTO session_index (id, file_path, instrument_key, title, provider, model, created_at, updated_at, message_count, first_message)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           file_path = excluded.file_path,
           instrument_key = excluded.instrument_key,
           title = excluded.title,
           provider = excluded.provider,
           model = excluded.model,
           updated_at = excluded.updated_at,
           message_count = excluded.message_count,
           first_message = excluded.first_message`,
      )
      .run(
        info.id,
        info.path,
        info.instrumentKey,
        info.title,
        info.provider,
        info.model,
        info.created.toISOString(),
        info.modified.toISOString(),
        info.messageCount,
        info.firstMessage,
      );
  }

  updateActivity(sessionId: string, updatedAt: Date, messageCount: number): void {
    this.getConn()
      .prepare("UPDATE session_index SET updated_at = ?, message_count = ? WHERE id = ?")
      .run(updatedAt.toISOString(), messageCount, sessionId);
  }

  get(sessionId: string): SessionIndexRow | null {
    const row = this.getConn().prepare("SELECT * FROM session_index WHERE id = ?").get(sessionId) as RawRow | undefined;
    return row ? rowToIndex(row) : null;
  }

  listSessions(input: { instrumentKey?: string | null; limit?: number } = {}): SessionIndexRow[] {
    const limit = input.limit ?? 200;
    if (input.instrumentKey !== undefined && input.instrumentKey !== null) {
      const rows = this.getConn()
        .prepare("SELECT * FROM session_index WHERE instrument_key = ? ORDER BY updated_at DESC LIMIT ?")
        .all(input.instrumentKey, limit) as RawRow[];
      return rows.map(rowToIndex);
    }
    const rows = this.getConn()
      .prepare("SELECT * FROM session_index ORDER BY updated_at DESC LIMIT ?")
      .all(limit) as RawRow[];
    return rows.map(rowToIndex);
  }

  listAllSessions(input: { limit?: number } = {}): SessionIndexRow[] {
    return this.listSessions({ limit: input.limit });
  }

  deleteSession(sessionId: string): boolean {
    return this.getConn().prepare("DELETE FROM session_index WHERE id = ?").run(sessionId).changes > 0;
  }

  reconcile(sessions: SessionInfo[]): void {
    const existing = new Set(
      (this.getConn().prepare("SELECT id FROM session_index").all() as Array<{ id: string }>).map((r) => r.id),
    );

    const seen = new Set<string>();
    const upsertStmt = this.getConn().prepare(
      `INSERT INTO session_index (id, file_path, instrument_key, title, provider, model, created_at, updated_at, message_count, first_message)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         file_path = excluded.file_path,
         instrument_key = excluded.instrument_key,
         title = excluded.title,
         provider = excluded.provider,
         model = excluded.model,
         updated_at = excluded.updated_at,
         message_count = excluded.message_count,
         first_message = excluded.first_message`,
    );
    const deleteStmt = this.getConn().prepare("DELETE FROM session_index WHERE id = ?");

    const tx = this.getConn().transaction(() => {
      for (const info of sessions) {
        seen.add(info.id);
        upsertStmt.run(
          info.id,
          info.path,
          info.instrumentKey,
          info.title,
          info.provider,
          info.model,
          info.created.toISOString(),
          info.modified.toISOString(),
          info.messageCount,
          info.firstMessage,
        );
      }
      for (const id of existing) {
        if (!seen.has(id)) deleteStmt.run(id);
      }
    });
    tx();
  }
}

interface RawRow {
  id: string;
  file_path: string;
  instrument_key: string | null;
  title: string | null;
  provider: string;
  model: string;
  created_at: string;
  updated_at: string;
  message_count: number;
  first_message: string;
}

function rowToIndex(row: RawRow): SessionIndexRow {
  return {
    id: row.id,
    filePath: row.file_path,
    instrumentKey: row.instrument_key,
    title: row.title ?? "",
    provider: row.provider,
    model: row.model,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    messageCount: row.message_count,
    firstMessage: row.first_message,
  };
}
