/**
 * UnreadStore — Human（及未来 Agent）的 target-local 已读游标。
 *
 * 按 (viewer, ChatTarget) 存储 last_read_seq。未读数是投影：
 * count(seq > last_read_seq 的消息)。这不是 Agent inbox；
 * Agent 激活注意力仍走 InboxStore。
 */
import Database from "better-sqlite3";
import path from "node:path";
import { BaseStore, defaultCacheDir, nowMs } from "../db.js";
import { initChatEventSchema } from "./events.js";
import type { ChatTarget } from "../channel/domain.js";
import { chatTargetFromRow, chatTargetRef } from "../channel/domain.js";

/** 未读游标所属的查看者（Human Owner 或 Agent）。 */
export type UnreadViewer = { type: "human" | "agent"; id: string };

interface UnreadRow {
  viewer_type: "human" | "agent";
  viewer_id: string;
  target_kind: ChatTarget["kind"] | "direct-chat";
  target_ref: string;
  last_read_message_id: string | null;
  last_read_seq: number;
  updated_at_ms: number;
}

/**
 * Human Owner 与 Agent 的 target-local 未读游标。
 * 未读数由 message seq > last_read_seq 投影得到。
 */
export class UnreadStore extends BaseStore {
  constructor(dbPath = path.join(defaultCacheDir(), "chat.sqlite3")) {
    super(dbPath);
  }

  protected override initSchema(conn: Database.Database): void {
    initChatEventSchema(conn);
    conn.exec(`
      CREATE TABLE IF NOT EXISTS chat_unread_cursors (
        viewer_type TEXT NOT NULL CHECK (viewer_type IN ('human', 'agent')),
        viewer_id TEXT NOT NULL,
        target_kind TEXT NOT NULL CHECK (target_kind IN ('direct-chat', 'direct-message', 'channel')),
        target_ref TEXT NOT NULL,
        last_read_message_id TEXT,
        last_read_seq INTEGER NOT NULL DEFAULT 0,
        updated_at_ms INTEGER NOT NULL,
        PRIMARY KEY (viewer_type, viewer_id, target_kind, target_ref)
      );
    `);
  }

  /** 推进已读游标；不会回退（与已有 seq 取 MAX）。 */
  markRead(input: {
    viewer: UnreadViewer;
    target: ChatTarget;
    messageId: string | null;
    seq: number;
  }): void {
    const conn = this.getConn();
    conn.prepare(`
      INSERT INTO chat_unread_cursors (
        viewer_type, viewer_id, target_kind, target_ref,
        last_read_message_id, last_read_seq, updated_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(viewer_type, viewer_id, target_kind, target_ref) DO UPDATE SET
        last_read_message_id = excluded.last_read_message_id,
        last_read_seq = MAX(chat_unread_cursors.last_read_seq, excluded.last_read_seq),
        updated_at_ms = excluded.updated_at_ms
    `).run(
      input.viewer.type,
      input.viewer.id,
      input.target.kind,
      chatTargetRef(input.target),
      input.messageId,
      Math.max(0, Math.floor(input.seq)),
      nowMs(),
    );
  }

  getCursor(viewer: UnreadViewer, target: ChatTarget): { lastReadMessageId: string | null; lastReadSeq: number } {
    const row = this.getConn().prepare(`
      SELECT * FROM chat_unread_cursors
      WHERE viewer_type = ? AND viewer_id = ? AND target_kind = ? AND target_ref = ?
    `).get(
      viewer.type,
      viewer.id,
      target.kind,
      chatTargetRef(target),
    ) as UnreadRow | undefined;
    return {
      lastReadMessageId: row?.last_read_message_id ?? null,
      lastReadSeq: row?.last_read_seq ?? 0,
    };
  }

  listForViewer(viewer: UnreadViewer): Array<{
    target: ChatTarget;
    lastReadMessageId: string | null;
    lastReadSeq: number;
  }> {
    const rows = this.getConn().prepare(`
      SELECT * FROM chat_unread_cursors
      WHERE viewer_type = ? AND viewer_id = ?
    `).all(viewer.type, viewer.id) as UnreadRow[];
    return rows.map((row) => ({
      target: chatTargetFromRow(row.target_kind, row.target_ref),
      lastReadMessageId: row.last_read_message_id,
      lastReadSeq: row.last_read_seq,
    }));
  }
}
