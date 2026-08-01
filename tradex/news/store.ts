import Database from "better-sqlite3";
import path from "node:path";
import { BaseStore, defaultCacheDir, jsonDumps, jsonLoads } from "../db.js";
import { FOREXFACTORY_SOURCE } from "./providers/forexfactory.js";
import { NewsItem } from "./types.js";

export const DEFAULT_NEWS_FILENAME = "news.sqlite3";

export interface FetchCursor {
  source: string;
  etag: string | null;
  lastModified: string | null;
}

export function defaultNewsStorePath(): string {
  return path.join(defaultCacheDir(), DEFAULT_NEWS_FILENAME);
}

export class NewsStore extends BaseStore {
  constructor(dbPath: string | null = null) {
    super(dbPath ?? defaultNewsStorePath());
  }

  protected override initSchema(conn: Database.Database): void {
    conn.exec(`
      CREATE TABLE IF NOT EXISTS news_items (
        url TEXT PRIMARY KEY,
        source TEXT NOT NULL,
        title TEXT NOT NULL,
        summary TEXT NOT NULL,
        published_at_ms INTEGER NOT NULL,
        fetched_at_ms INTEGER NOT NULL,
        keywords_json TEXT NOT NULL DEFAULT '[]'
      );
      CREATE INDEX IF NOT EXISTS idx_news_recent ON news_items (published_at_ms DESC, fetched_at_ms DESC);
      CREATE TABLE IF NOT EXISTS news_cursors (
        source TEXT PRIMARY KEY,
        etag TEXT,
        last_modified TEXT
      );
    `);
  }

  upsertItems(items: Iterable<NewsItem>): NewsItem[] {
    const rows = [...items];
    const stmt = this.getConn().prepare(`
      INSERT INTO news_items (url, source, title, summary, published_at_ms, fetched_at_ms, keywords_json)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(url) DO UPDATE SET
        source = excluded.source,
        title = excluded.title,
        summary = excluded.summary,
        -- First-seen wins, but only for Forex Factory: it has no publish
        -- timestamp and would otherwise rewrite published_at_ms to "now" on
        -- every poll, pinning those rows to the top of recent() and
        -- defeating retention prune. Other sources (Reuters) carry a real
        -- publication date and must keep taking the latest value, e.g. if a
        -- story's timestamp is corrected after first being seen.
        published_at_ms = CASE WHEN excluded.source = '${FOREXFACTORY_SOURCE}'
          THEN MIN(news_items.published_at_ms, excluded.published_at_ms)
          ELSE excluded.published_at_ms
        END,
        fetched_at_ms = excluded.fetched_at_ms,
        keywords_json = excluded.keywords_json
    `);
    const tx = this.getConn().transaction((values: NewsItem[]) => {
      for (const item of values) stmt.run(item.url, item.source, item.title, item.summary, item.publishedAtMs, item.fetchedAtMs, jsonDumps(item.keywords));
    });
    tx(rows);
    return rows;
  }

  recent(input: { limit?: number; sinceMs?: number | null } = {}): NewsItem[] {
    const clauses = input.sinceMs ? "WHERE published_at_ms >= ?" : "";
    const params = input.sinceMs ? [input.sinceMs] : [];
    const rows = this.getConn()
      .prepare(`SELECT * FROM news_items ${clauses} ORDER BY published_at_ms DESC, fetched_at_ms DESC LIMIT ?`)
      .all(...params, input.limit ?? 50) as NewsRow[];
    return rows.map(rowToItem);
  }

  getCursor(source: string): FetchCursor | null {
    const row = this.getConn().prepare("SELECT * FROM news_cursors WHERE source = ?").get(source) as CursorRow | undefined;
    return row ? { source: row.source, etag: row.etag, lastModified: row.last_modified } : null;
  }

  setCursor(source: string, etag: string | null, lastModified: string | null): void {
    this.getConn()
      .prepare("INSERT INTO news_cursors (source, etag, last_modified) VALUES (?, ?, ?) ON CONFLICT(source) DO UPDATE SET etag = excluded.etag, last_modified = excluded.last_modified")
      .run(source, etag, lastModified);
  }

  pruneOlderThan(cutoffMs: number): number {
    return this.getConn().prepare("DELETE FROM news_items WHERE published_at_ms < ?").run(cutoffMs).changes;
  }

  countBySource(source: string): number {
    const row = this.getConn().prepare("SELECT COUNT(*) AS n FROM news_items WHERE source = ?").get(source) as { n: number };
    return row.n;
  }
}

interface NewsRow {
  url: string;
  source: string;
  title: string;
  summary: string;
  published_at_ms: number;
  fetched_at_ms: number;
  keywords_json: string;
}

interface CursorRow {
  source: string;
  etag: string | null;
  last_modified: string | null;
}

function rowToItem(row: NewsRow): NewsItem {
  const keywords = jsonLoads(row.keywords_json);
  return {
    url: row.url,
    source: row.source,
    title: row.title,
    summary: row.summary,
    publishedAtMs: row.published_at_ms,
    fetchedAtMs: row.fetched_at_ms,
    keywords: Array.isArray(keywords) ? keywords.map(String) : [],
  };
}
