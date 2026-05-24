import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const DEFAULT_CACHE_SUBDIR = "tradex";

// Keep all local SQLite files under the user's cache directory by default.
export function defaultCacheDir(): string {
  return path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache"), DEFAULT_CACHE_SUBDIR);
}

export function nowMs(): number {
  return Date.now();
}

export function jsonDumps(value: unknown): string {
  return JSON.stringify(value);
}

// Treat invalid or empty JSON columns as missing data instead of throwing.
export function jsonLoads(value: unknown): unknown | null {
  if (typeof value !== "string" || !value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

// Shared base class for SQLite-backed stores.
export abstract class BaseStore {
  readonly dbPath: string;
  private conn: Database.Database | null = null;

  constructor(dbPath: string) {
    this.dbPath = dbPath;
  }

  protected getConn(): Database.Database {
    if (this.conn !== null) return this.conn;

    // Connections are opened lazily so unused stores do not create files.
    fs.mkdirSync(path.dirname(this.dbPath), { recursive: true });
    const conn = new Database(this.dbPath);
    conn.pragma("journal_mode = WAL");
    conn.pragma("foreign_keys = ON");
    this.initSchema(conn);
    this.conn = conn;
    return conn;
  }

  protected initSchema(_conn: Database.Database): void {
    // Subclasses create their tables lazily on first connection.
  }

  close(): void {
    if (this.conn !== null) {
      this.conn.close();
      this.conn = null;
    }
  }
}
