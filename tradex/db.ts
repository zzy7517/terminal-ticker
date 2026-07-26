import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const DEFAULT_CACHE_SUBDIR = "tradex";

/**
 * App home: everything tradex persists lives under one root, so backup /
 * cleanup / uninstall are a single directory. Override with TRADEX_HOME.
 *
 *   ~/.tradex/secrets.toml       — secrets vault (config/secrets.ts)
 *   ~/.tradex/data/              — SQLite stores, agent contexts, sessions
 *   ~/.tradex/claude_sessions/   — Claude Code session roots
 *   ~/.tradex/cursor_sessions/   — Cursor session roots
 */
export function tradexHome(): string {
  const override = process.env.TRADEX_HOME;
  if (override && override.trim()) return path.resolve(override.trim());
  return path.join(os.homedir(), ".tradex");
}

let resolvedDataDir: string | null = null;

/**
 * Directory for all persisted stores. Despite the historical name this holds
 * real data (trade history, chat messages), not just caches.
 *
 * Memoized, and migrates the legacy XDG location (~/.cache/tradex) into
 * ~/.tradex/data on first call so existing installs keep their history. The
 * first call happens before any store opens a database — store constructors
 * resolve their default paths through here.
 */
export function defaultCacheDir(): string {
  if (resolvedDataDir) return resolvedDataDir;

  const dir = path.join(tradexHome(), "data");
  const legacy = path.join(
    process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache"),
    DEFAULT_CACHE_SUBDIR,
  );

  if (!fs.existsSync(dir) && fs.existsSync(legacy)) {
    try {
      fs.mkdirSync(path.dirname(dir), { recursive: true });
      fs.renameSync(legacy, dir);
      console.log(`[db] migrated data directory: ${legacy} -> ${dir}`);
    } catch (error) {
      // Cross-device rename or permission failure: keep using the legacy
      // location rather than silently starting over with empty stores.
      console.warn(
        `[db] failed to migrate ${legacy} to ${dir}; continuing with the legacy path:`,
        error instanceof Error ? error.message : error,
      );
      resolvedDataDir = legacy;
      return legacy;
    }
  }

  resolvedDataDir = dir;
  return dir;
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
