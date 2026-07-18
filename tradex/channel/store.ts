import Database from "better-sqlite3";
import crypto from "node:crypto";
import path from "node:path";
import { BaseStore, defaultCacheDir, nowMs } from "../db.js";
import type { Channel, ChannelMessage } from "./domain.js";

interface ChannelRow {
  id: string;
  name: string;
  topic: string;
  visibility: "public" | "private";
  version: number;
  created_at_ms: number;
  archived_at_ms: number | null;
}

interface ChannelMessageRow {
  id: string;
  channel_id: string;
  channel_seq: number;
  author_type: "human" | "agent" | "system";
  author_id: string;
  kind: "message" | "system";
  content: string;
  thread_root_id: string | null;
  created_at_ms: number;
}

export class ChannelStore extends BaseStore {
  constructor(dbPath = path.join(defaultCacheDir(), "chat.sqlite3")) {
    super(dbPath);
  }

  protected override initSchema(conn: Database.Database): void {
    conn.exec(`
      CREATE TABLE IF NOT EXISTS chat_channels (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        topic TEXT NOT NULL,
        visibility TEXT NOT NULL CHECK (visibility IN ('public', 'private')),
        version INTEGER NOT NULL DEFAULT 0,
        created_at_ms INTEGER NOT NULL,
        archived_at_ms INTEGER
      );
      CREATE TABLE IF NOT EXISTS channel_messages (
        id TEXT PRIMARY KEY,
        channel_id TEXT NOT NULL REFERENCES chat_channels(id) ON DELETE CASCADE,
        channel_seq INTEGER NOT NULL,
        author_type TEXT NOT NULL CHECK (author_type IN ('human', 'agent', 'system')),
        author_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('message', 'system')),
        content TEXT NOT NULL,
        thread_root_id TEXT REFERENCES channel_messages(id),
        created_at_ms INTEGER NOT NULL,
        UNIQUE (channel_id, channel_seq)
      );
      CREATE INDEX IF NOT EXISTS idx_channel_messages_timeline
        ON channel_messages (channel_id, channel_seq DESC);
    `);
  }

  createChannel(input: { name: string; topic?: string; visibility?: "public" | "private" }): Channel {
    const name = normalizeChannelName(input.name);
    const id = crypto.randomUUID();
    this.getConn().prepare(`
      INSERT INTO chat_channels (id, name, topic, visibility, version, created_at_ms, archived_at_ms)
      VALUES (?, ?, ?, ?, 0, ?, NULL)
    `).run(id, name, input.topic?.trim() ?? "", input.visibility ?? "public", nowMs());
    return this.getChannel(id)!;
  }

  getChannel(id: string): Channel | null {
    const row = this.getConn().prepare("SELECT * FROM chat_channels WHERE id = ?").get(id) as ChannelRow | undefined;
    return row ? channelFromRow(row) : null;
  }

  listChannels(): Channel[] {
    const rows = this.getConn().prepare(`
      SELECT * FROM chat_channels WHERE archived_at_ms IS NULL ORDER BY name
    `).all() as ChannelRow[];
    return rows.map(channelFromRow);
  }

  appendMessage(input: { channelId: string; authorId: string; content: string; threadRootId?: string | null }): ChannelMessage {
    const content = input.content.trim();
    if (!content) throw new Error("message content is required");
    const conn = this.getConn();
    return conn.transaction(() => {
      const channel = this.getChannel(input.channelId);
      if (!channel || channel.archivedAtMs !== null) throw new Error("Channel not found");
      const next = conn.prepare(`
        SELECT COALESCE(MAX(channel_seq), 0) + 1 AS channel_seq
        FROM channel_messages WHERE channel_id = ?
      `).get(input.channelId) as { channel_seq: number };
      const id = crypto.randomUUID();
      conn.prepare(`
        INSERT INTO channel_messages (
          id, channel_id, channel_seq, author_type, author_id, kind, content, thread_root_id, created_at_ms
        ) VALUES (?, ?, ?, 'human', ?, 'message', ?, ?, ?)
      `).run(id, input.channelId, next.channel_seq, input.authorId, content, input.threadRootId ?? null, nowMs());
      conn.prepare("UPDATE chat_channels SET version = version + 1 WHERE id = ?").run(input.channelId);
      return this.requireMessage(id);
    })();
  }

  listMessages(input: { channelId: string; beforeSeq?: number | null; limit?: number }): { messages: ChannelMessage[]; nextBeforeSeq: number | null } {
    const limit = Math.max(1, Math.min(100, Math.floor(input.limit ?? 50)));
    const beforeSeq = input.beforeSeq ?? Number.MAX_SAFE_INTEGER;
    const rows = this.getConn().prepare(`
      SELECT * FROM channel_messages
      WHERE channel_id = ? AND channel_seq < ?
      ORDER BY channel_seq DESC
      LIMIT ?
    `).all(input.channelId, beforeSeq, limit) as ChannelMessageRow[];
    return {
      messages: rows.map(messageFromRow),
      nextBeforeSeq: rows.length === limit ? rows.at(-1)!.channel_seq : null,
    };
  }

  private requireMessage(id: string): ChannelMessage {
    const row = this.getConn().prepare("SELECT * FROM channel_messages WHERE id = ?").get(id) as ChannelMessageRow | undefined;
    if (!row) throw new Error(`Message not found: ${id}`);
    return messageFromRow(row);
  }
}

function normalizeChannelName(value: string): string {
  const name = value.trim().toLowerCase();
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) {
    throw new Error("Channel name must contain lowercase letters, numbers, and single hyphens");
  }
  return name;
}

function channelFromRow(row: ChannelRow): Channel {
  return {
    id: row.id,
    name: row.name,
    topic: row.topic,
    visibility: row.visibility,
    version: row.version,
    createdAtMs: row.created_at_ms,
    archivedAtMs: row.archived_at_ms,
  };
}

function messageFromRow(row: ChannelMessageRow): ChannelMessage {
  return {
    id: row.id,
    channelId: row.channel_id,
    channelSeq: row.channel_seq,
    authorType: row.author_type,
    authorId: row.author_id,
    kind: row.kind,
    content: row.content,
    threadRootId: row.thread_root_id,
    createdAtMs: row.created_at_ms,
  };
}
