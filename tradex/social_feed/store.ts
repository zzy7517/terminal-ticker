import Database from "better-sqlite3";
import path from "node:path";
import { BaseStore, defaultCacheDir, jsonDumps, jsonLoads } from "../db.js";
import { SocialFeedItem, defaultMetrics, socialItemToPayload } from "./types.js";

export const DEFAULT_SOCIAL_FEED_FILENAME = "social_feed.sqlite3";

export function defaultSocialFeedStorePath(): string {
  return path.join(defaultCacheDir(), DEFAULT_SOCIAL_FEED_FILENAME);
}

export class SocialFeedStore extends BaseStore {
  constructor(dbPath: string | null = null) {
    super(dbPath ?? defaultSocialFeedStorePath());
  }

  protected override initSchema(conn: Database.Database): void {
    conn.exec(`
      CREATE TABLE IF NOT EXISTS social_feed_items (
        source TEXT NOT NULL,
        external_id TEXT NOT NULL,
        url TEXT NOT NULL,
        author_id TEXT NOT NULL,
        author_name TEXT NOT NULL,
        author_handle TEXT NOT NULL,
        author_profile_image_url TEXT NOT NULL,
        author_verified INTEGER NOT NULL,
        text TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL,
        fetched_at_ms INTEGER NOT NULL,
        metrics_json TEXT NOT NULL,
        urls_json TEXT NOT NULL,
        lang TEXT NOT NULL,
        is_repost INTEGER NOT NULL,
        reposted_by TEXT,
        quoted_json TEXT,
        raw_json TEXT NOT NULL,
        PRIMARY KEY(source, external_id)
      );
      CREATE INDEX IF NOT EXISTS idx_social_feed_created
      ON social_feed_items(created_at_ms DESC);
    `);
  }

  upsertItems(items: Iterable<SocialFeedItem>): SocialFeedItem[] {
    const rows = [...items];
    if (rows.length === 0) return [];
    if (this.usesPayloadJsonSchema()) {
      const stmt = this.getConn().prepare(`
        INSERT INTO social_feed_items (source, external_id, created_at_ms, fetched_at_ms, payload_json)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(source, external_id) DO UPDATE SET
          created_at_ms = excluded.created_at_ms,
          fetched_at_ms = excluded.fetched_at_ms,
          payload_json = excluded.payload_json
      `);
      const tx = this.getConn().transaction((values: SocialFeedItem[]) => {
        for (const item of values) stmt.run(item.source, item.externalId, item.createdAtMs, item.fetchedAtMs, jsonDumps(item));
      });
      tx(rows);
      return rows;
    }
    const insert = this.getConn().prepare(`
      INSERT INTO social_feed_items(
        source, external_id, url,
        author_id, author_name, author_handle,
        author_profile_image_url, author_verified,
        text, created_at_ms, fetched_at_ms,
        metrics_json, urls_json, lang,
        is_repost, reposted_by, quoted_json, raw_json
      )
      VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(source, external_id) DO UPDATE SET
        url = excluded.url,
        author_id = excluded.author_id,
        author_name = excluded.author_name,
        author_handle = excluded.author_handle,
        author_profile_image_url = excluded.author_profile_image_url,
        author_verified = excluded.author_verified,
        text = excluded.text,
        created_at_ms = excluded.created_at_ms,
        fetched_at_ms = excluded.fetched_at_ms,
        metrics_json = excluded.metrics_json,
        urls_json = excluded.urls_json,
        lang = excluded.lang,
        is_repost = excluded.is_repost,
        reposted_by = excluded.reposted_by,
        quoted_json = excluded.quoted_json,
        raw_json = excluded.raw_json
    `);
    const tx = this.getConn().transaction((values: SocialFeedItem[]) => {
      for (const item of values) insert.run(...itemDbValues(item));
    });
    tx(rows.filter((item) => item.externalId));
    return rows;
  }

  recentItems(input: { source?: string | null; limit?: number; sinceMs?: number | null } = {}): SocialFeedItem[] {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (input.source) {
      clauses.push("source = ?");
      params.push(input.source);
    }
    if (input.sinceMs) {
      clauses.push("created_at_ms >= ?");
      params.push(input.sinceMs);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    if (this.usesPayloadJsonSchema()) {
      const rows = this.getConn()
        .prepare(`SELECT payload_json FROM social_feed_items ${where} ORDER BY created_at_ms DESC, fetched_at_ms DESC LIMIT ?`)
        .all(...params, input.limit ?? 100) as Array<{ payload_json: string }>;
      return rows.map((row) => payloadToItem(jsonLoads(row.payload_json) as Record<string, unknown>));
    }
    const rows = this.getConn()
      .prepare(`SELECT * FROM social_feed_items ${where} ORDER BY created_at_ms DESC LIMIT ?`)
      .all(...params, input.limit ?? 100) as SocialFeedRow[];
    return rows.map(rowToItem);
  }

  getItem(input: { source: string; externalId: string }): SocialFeedItem | null {
    if (this.usesPayloadJsonSchema()) {
      const row = this.getConn().prepare("SELECT payload_json FROM social_feed_items WHERE source = ? AND external_id = ?").get(input.source, input.externalId) as { payload_json: string } | undefined;
      return row ? payloadToItem(jsonLoads(row.payload_json) as Record<string, unknown>) : null;
    }
    const row = this.getConn().prepare("SELECT * FROM social_feed_items WHERE source = ? AND external_id = ?").get(input.source, input.externalId) as SocialFeedRow | undefined;
    return row ? rowToItem(row) : null;
  }

  pruneItemsOlderThan(cutoffMs: number): number {
    return this.getConn().prepare("DELETE FROM social_feed_items WHERE created_at_ms < ?").run(cutoffMs).changes;
  }

  trimItems(input: { maxItems: number }): number {
    return this.getConn()
      .prepare(
        `DELETE FROM social_feed_items
         WHERE rowid NOT IN (
           SELECT rowid FROM social_feed_items ORDER BY created_at_ms DESC, fetched_at_ms DESC LIMIT ?
         )`,
      )
      .run(input.maxItems).changes;
  }

  private usesPayloadJsonSchema(): boolean {
    const columns = this.tableColumns();
    return columns.has("payload_json") && !columns.has("url");
  }

  private tableColumns(): Set<string> {
    const rows = this.getConn().prepare("PRAGMA table_info(social_feed_items)").all() as Array<{ name: string }>;
    return new Set(rows.map((row) => row.name));
  }
}

interface SocialFeedRow {
  source: string;
  external_id: string;
  url: string;
  author_id: string;
  author_name: string;
  author_handle: string;
  author_profile_image_url: string;
  author_verified: number;
  text: string;
  created_at_ms: number;
  fetched_at_ms: number;
  metrics_json: string;
  urls_json: string;
  lang: string;
  is_repost: number;
  reposted_by: string | null;
  quoted_json: string | null;
  raw_json: string;
}

function itemDbValues(item: SocialFeedItem): unknown[] {
  return [
    item.source,
    item.externalId,
    item.url,
    item.author.id,
    item.author.name,
    item.author.handle,
    item.author.profileImageUrl,
    item.author.verified ? 1 : 0,
    item.text,
    item.createdAtMs,
    item.fetchedAtMs,
    jsonDumps(item.metrics),
    jsonDumps(item.urls),
    item.lang,
    item.isRepost ? 1 : 0,
    item.repostedBy,
    jsonDumps(item.quotedItem ? socialItemToPayload(item.quotedItem, false) : null),
    jsonDumps(item.raw),
  ];
}

function rowToItem(row: SocialFeedRow): SocialFeedItem {
  const metrics = jsonLoads(row.metrics_json);
  const urls = jsonLoads(row.urls_json);
  const raw = jsonLoads(row.raw_json);
  const quoted = jsonLoads(row.quoted_json);
  return {
    source: row.source,
    externalId: row.external_id,
    url: row.url,
    author: {
      id: row.author_id,
      name: row.author_name,
      handle: row.author_handle,
      profileImageUrl: row.author_profile_image_url,
      verified: Boolean(row.author_verified),
    },
    text: row.text,
    createdAtMs: row.created_at_ms,
    fetchedAtMs: row.fetched_at_ms,
    metrics: { ...defaultMetrics(), ...((metrics || {}) as Record<string, number>) },
    urls: Array.isArray(urls) ? urls.map(String) : [],
    lang: row.lang,
    isRepost: Boolean(row.is_repost),
    repostedBy: row.reposted_by,
    quotedItem: quoted && typeof quoted === "object" && !Array.isArray(quoted) ? payloadToItem(quoted as Record<string, unknown>) : null,
    raw: raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {},
  };
}

function payloadToItem(payload: Record<string, unknown> | null): SocialFeedItem {
  const author = (payload?.author || {}) as Record<string, unknown>;
  return {
    source: String(payload?.source || ""),
    externalId: String(payload?.externalId || payload?.external_id || ""),
    url: String(payload?.url || ""),
    author: {
      id: String(author.id || ""),
      name: String(author.name || "Unknown"),
      handle: String(author.handle || "unknown"),
      profileImageUrl: String(author.profileImageUrl || author.profile_image_url || ""),
      verified: Boolean(author.verified),
    },
    text: String(payload?.text || ""),
    createdAtMs: Number(payload?.createdAtMs || payload?.created_at_ms || 0),
    fetchedAtMs: Number(payload?.fetchedAtMs || payload?.fetched_at_ms || 0),
    metrics: { ...defaultMetrics(), ...((payload?.metrics || {}) as Record<string, number>) },
    urls: Array.isArray(payload?.urls) ? payload.urls.map(String) : [],
    lang: String(payload?.lang || ""),
    isRepost: Boolean(payload?.isRepost || payload?.is_repost),
    repostedBy: typeof payload?.repostedBy === "string" ? payload.repostedBy : null,
    quotedItem: null,
    raw: (payload?.raw && typeof payload.raw === "object" && !Array.isArray(payload.raw) ? payload.raw : {}) as Record<string, unknown>,
  };
}
