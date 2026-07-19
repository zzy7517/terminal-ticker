/**
 * chat-events — Chat 变更事件日志（跨 Channel / DM）。
 *
 * 存于 chat.sqlite3，供 Human UI SSE / 轮询增量同步。
 * 只记录「发生了什么」（消息、draft、pin 等），不存消息正文权威副本。
 */
import Database from "better-sqlite3";
import path from "node:path";
import { BaseStore, defaultCacheDir, jsonLoads, nowMs } from "../db.js";
import {
  chatTargetFromRow,
  chatTargetRef,
  type ChatTarget,
} from "../channel/domain.js";

/** 一条可订阅的 Chat 变更事件。 */
export interface ChatEvent {
  seq: number;
  type: string;
  actorType: "human" | "agent" | "system";
  actorId: string;
  target: ChatTarget;
  entityType: string;
  entityId: string;
  payload: Record<string, unknown>;
  createdAtMs: number;
}

interface ChatEventRow {
  seq: number;
  type: string;
  actor_type: ChatEvent["actorType"];
  actor_id: string;
  target_kind: ChatTarget["kind"];
  target_ref: string;
  entity_type: string;
  entity_id: string;
  payload_json: string;
  created_at_ms: number;
}

/** 初始化 chat_events 表（可与 Overlay / Channel 共用同一连接）。 */
export function initChatEventSchema(conn: Database.Database): void {
  conn.exec(`
    CREATE TABLE IF NOT EXISTS chat_events (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL,
      actor_type TEXT NOT NULL CHECK (actor_type IN ('human', 'agent', 'system')),
      actor_id TEXT NOT NULL,
      target_kind TEXT NOT NULL CHECK (target_kind IN ('direct-chat', 'direct-message', 'channel')),
      target_ref TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL
    );
  `);
}

/** 追加一条事件并返回单调递增 seq。 */
export function appendChatEvent(conn: Database.Database, input: {
  type: string;
  actorType: ChatEvent["actorType"];
  actorId: string;
  target: ChatTarget;
  entityType: string;
  entityId: string;
  payload?: Record<string, unknown>;
}): number {
  const result = conn.prepare(`
    INSERT INTO chat_events (
      type, actor_type, actor_id, target_kind, target_ref,
      entity_type, entity_id, payload_json, created_at_ms
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.type,
    input.actorType,
    input.actorId,
    input.target.kind,
    chatTargetRef(input.target),
    input.entityType,
    input.entityId,
    JSON.stringify(input.payload ?? {}),
    nowMs(),
  );
  return Number(result.lastInsertRowid);
}

/** Chat 事件只读 Store，供 API 增量拉取。 */
export class ChatEventStore extends BaseStore {
  constructor(dbPath = path.join(defaultCacheDir(), "chat.sqlite3")) {
    super(dbPath);
  }

  protected override initSchema(conn: Database.Database): void {
    initChatEventSchema(conn);
  }

  /** 当前最大事件序号。 */
  latestSeq(): number {
    const row = this.getConn().prepare("SELECT COALESCE(MAX(seq), 0) AS seq FROM chat_events").get() as { seq: number };
    return row.seq;
  }

  /** 拉取 afterSeq 之后的事件（含最新 seq，便于客户端游标）。 */
  list(input: { afterSeq?: number; limit?: number }): { events: ChatEvent[]; latestSeq: number } {
    const afterSeq = Math.max(0, Math.floor(input.afterSeq ?? 0));
    const limit = Math.max(1, Math.min(500, Math.floor(input.limit ?? 100)));
    const rows = this.getConn().prepare(`
      SELECT * FROM chat_events WHERE seq > ? ORDER BY seq LIMIT ?
    `).all(afterSeq, limit) as ChatEventRow[];
    return { events: rows.map(eventFromRow), latestSeq: this.latestSeq() };
  }
}

function eventFromRow(row: ChatEventRow): ChatEvent {
  const payload = jsonLoads(row.payload_json);
  return {
    seq: row.seq,
    type: row.type,
    actorType: row.actor_type,
    actorId: row.actor_id,
    target: chatTargetFromRow(row.target_kind, row.target_ref),
    entityType: row.entity_type,
    entityId: row.entity_id,
    payload: payload && typeof payload === "object" && !Array.isArray(payload)
      ? payload as Record<string, unknown>
      : {},
    createdAtMs: row.created_at_ms,
  };
}
