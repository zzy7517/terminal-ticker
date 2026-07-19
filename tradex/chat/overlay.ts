/**
 * chat-overlay — Saved / Pinned 消息引用的 overlay 存储。
 *
 * 对应 Raft 侧栏 Saved / Pinned：只存「指向哪条消息」的引用，
 * 不复制 Shared Message Fabric 正文；权威消息仍在 ChannelStore / MessageStore。
 */
import Database from "better-sqlite3";
import path from "node:path";
import { appendChatEvent, initChatEventSchema } from "./events.js";
import { BaseStore, defaultCacheDir, nowMs } from "../db.js";
import {
  chatTargetFromRow,
  chatTargetRef,
  type ChatTarget,
} from "../channel/domain.js";

/** 一条 Saved 或 Pinned 引用（actor + ChatTarget + messageId）。 */
export interface ChatMessageReference {
  actorId: string;
  target: ChatTarget;
  messageId: string;
  createdAtMs: number;
}

interface ReferenceRow {
  actor_id: string;
  target_kind: ChatTarget["kind"];
  target_ref: string;
  message_id: string;
  created_at_ms: number;
}

interface ReferenceInput {
  actorId: string;
  target: ChatTarget;
  messageId: string;
}

/**
 * Saved（按 actor）与 Pinned（按 target）的 SQLite overlay。
 * 写入时追加 chat_events，供前端实时刷新。
 */
export class ChatOverlayStore extends BaseStore {
  constructor(dbPath = path.join(defaultCacheDir(), "chat.sqlite3")) {
    super(dbPath);
  }

  protected override initSchema(conn: Database.Database): void {
    initChatEventSchema(conn);
    conn.exec(`
      CREATE TABLE IF NOT EXISTS chat_saved (
        actor_id TEXT NOT NULL,
        target_kind TEXT NOT NULL CHECK (target_kind IN ('direct-chat', 'direct-message', 'channel')),
        target_ref TEXT NOT NULL,
        message_id TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL,
        PRIMARY KEY (actor_id, target_kind, target_ref, message_id)
      );
      CREATE TABLE IF NOT EXISTS chat_pins (
        actor_id TEXT NOT NULL,
        target_kind TEXT NOT NULL CHECK (target_kind IN ('direct-chat', 'direct-message', 'channel')),
        target_ref TEXT NOT NULL,
        message_id TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL,
        PRIMARY KEY (target_kind, target_ref, message_id)
      );
    `);
  }

  /** 收藏消息（Saved）。 */
  save(input: ReferenceInput): void {
    this.add("chat_saved", "saved.added", input);
  }

  /** 取消收藏。 */
  unsave(input: ReferenceInput): void {
    this.remove("chat_saved", "saved.removed", input, true);
  }

  /** 固定消息到目标（Pinned）。 */
  pin(input: ReferenceInput): void {
    this.add("chat_pins", "pin.added", input);
  }

  /** 取消固定。 */
  unpin(input: ReferenceInput): void {
    this.remove("chat_pins", "pin.removed", input, false);
  }

  /** 列出某 actor 的全部 Saved。 */
  listSaved(actorId: string): ChatMessageReference[] {
    const rows = this.getConn().prepare(`
      SELECT * FROM chat_saved WHERE actor_id = ? ORDER BY created_at_ms DESC, rowid DESC
    `).all(actorId) as ReferenceRow[];
    return rows.map(referenceFromRow);
  }

  /** 列出某 ChatTarget 上的 Pinned。 */
  listPinned(target: ChatTarget): ChatMessageReference[] {
    const rows = this.getConn().prepare(`
      SELECT * FROM chat_pins WHERE target_kind = ? AND target_ref = ?
      ORDER BY created_at_ms DESC, rowid DESC
    `).all(target.kind, chatTargetRef(target)) as ReferenceRow[];
    return rows.map(referenceFromRow);
  }

  /** 列出全部 Pinned（跨目标，供侧栏汇总）。 */
  listAllPinned(): ChatMessageReference[] {
    const rows = this.getConn().prepare(`
      SELECT * FROM chat_pins ORDER BY created_at_ms DESC, rowid DESC
    `).all() as ReferenceRow[];
    return rows.map(referenceFromRow);
  }

  private add(table: "chat_saved" | "chat_pins", eventType: string, input: ReferenceInput): void {
    validateReference(input);
    const conn = this.getConn();
    conn.transaction(() => {
      const result = conn.prepare(`
        INSERT OR IGNORE INTO ${table} (actor_id, target_kind, target_ref, message_id, created_at_ms)
        VALUES (?, ?, ?, ?, ?)
      `).run(input.actorId, input.target.kind, chatTargetRef(input.target), input.messageId, nowMs());
      if (result.changes > 0) this.appendEvent(conn, eventType, input);
    })();
  }

  private remove(table: "chat_saved" | "chat_pins", eventType: string, input: ReferenceInput, actorScoped: boolean): void {
    validateReference(input);
    const conn = this.getConn();
    conn.transaction(() => {
      const actorClause = actorScoped ? "AND actor_id = ?" : "";
      const params = actorScoped
        ? [input.target.kind, chatTargetRef(input.target), input.messageId, input.actorId]
        : [input.target.kind, chatTargetRef(input.target), input.messageId];
      const result = conn.prepare(`
        DELETE FROM ${table}
        WHERE target_kind = ? AND target_ref = ? AND message_id = ? ${actorClause}
      `).run(...params);
      if (result.changes > 0) this.appendEvent(conn, eventType, input);
    })();
  }

  private appendEvent(conn: Database.Database, type: string, input: ReferenceInput): void {
    appendChatEvent(conn, {
      type,
      actorType: "human",
      actorId: input.actorId,
      target: input.target,
      entityType: "message",
      entityId: input.messageId,
    });
  }
}

function validateReference(input: ReferenceInput): void {
  if (!input.actorId.trim()) throw new Error("actorId is required");
  if (!input.messageId.trim()) throw new Error("messageId is required");
}

function referenceFromRow(row: ReferenceRow): ChatMessageReference {
  return {
    actorId: row.actor_id,
    target: chatTargetFromRow(row.target_kind, row.target_ref),
    messageId: row.message_id,
    createdAtMs: row.created_at_ms,
  };
}
