import Database from "better-sqlite3";
import crypto from "node:crypto";
import path from "node:path";
import { BaseStore, defaultCacheDir, nowMs } from "../db.js";
import { initChatEventSchema } from "../chat-events.js";
import type { ChatTarget } from "../channel/domain.js";
import { chatTargetFromRow, chatTargetRef } from "../channel/domain.js";

export type InboxReason =
  | "joined-channel"
  | "mention"
  | "dm"
  | "thread"
  | "reminder"
  | "held-draft"
  | "system";

export type InboxStatus = "pending" | "read" | "ignored" | "deferred";

export interface InboxItem {
  id: string;
  agentId: string;
  target: ChatTarget;
  firstMessageId: string;
  latestMessageId: string;
  reason: InboxReason;
  status: InboxStatus;
  availableAtMs: number;
  createdAtMs: number;
}

interface InboxRow {
  id: string;
  agent_id: string;
  target_kind: ChatTarget["kind"] | "direct-chat";
  target_ref: string;
  first_message_id: string;
  latest_message_id: string;
  reason: InboxReason;
  status: InboxStatus;
  available_at_ms: number;
  created_at_ms: number;
}

export class InboxStore extends BaseStore {
  constructor(dbPath = path.join(defaultCacheDir(), "chat.sqlite3")) {
    super(dbPath);
  }

  protected override initSchema(conn: Database.Database): void {
    initChatEventSchema(conn);
    conn.exec(`
      CREATE TABLE IF NOT EXISTS agent_inbox (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        target_kind TEXT NOT NULL CHECK (target_kind IN ('direct-chat', 'direct-message', 'channel')),
        target_ref TEXT NOT NULL,
        first_message_id TEXT NOT NULL,
        latest_message_id TEXT NOT NULL,
        reason TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending', 'read', 'ignored', 'deferred')),
        available_at_ms INTEGER NOT NULL,
        created_at_ms INTEGER NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_inbox_dedupe
        ON agent_inbox (agent_id, target_kind, target_ref, reason, first_message_id);
      CREATE INDEX IF NOT EXISTS idx_agent_inbox_pending
        ON agent_inbox (agent_id, status, available_at_ms);
    `);
  }

  /** Ensure schema exists without starting a write transaction. Call before cross-store atomic writes. */
  ensureReady(): void {
    this.getConn();
  }

  notifyWithConn(conn: Database.Database, input: {
    agentId: string;
    target: ChatTarget;
    messageId: string;
    reason: InboxReason;
    availableAtMs?: number;
  }): void {
    if (!input.agentId.trim()) throw new Error("agentId is required");
    const now = nowMs();
    const availableAtMs = input.availableAtMs ?? now;
    const existing = conn.prepare(`
      SELECT * FROM agent_inbox
      WHERE agent_id = ? AND target_kind = ? AND target_ref = ? AND reason = ?
        AND status = 'pending'
      ORDER BY created_at_ms DESC LIMIT 1
    `).get(
      input.agentId,
      input.target.kind,
      chatTargetRef(input.target),
      input.reason,
    ) as InboxRow | undefined;

    if (existing) {
      conn.prepare(`
        UPDATE agent_inbox SET latest_message_id = ?, available_at_ms = ?
        WHERE id = ?
      `).run(input.messageId, Math.min(existing.available_at_ms, availableAtMs), existing.id);
      return;
    }

    const id = crypto.randomUUID();
    try {
      conn.prepare(`
        INSERT INTO agent_inbox (
          id, agent_id, target_kind, target_ref, first_message_id, latest_message_id,
          reason, status, available_at_ms, created_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
      `).run(
        id,
        input.agentId,
        input.target.kind,
        chatTargetRef(input.target),
        input.messageId,
        input.messageId,
        input.reason,
        availableAtMs,
        now,
      );
    } catch {
      // Unique on first_message_id: treat as idempotent success.
    }
  }

  /** Upsert pending inbox item for an Agent/target/reason; extends latest cursor when pending. */
  notify(input: {
    agentId: string;
    target: ChatTarget;
    messageId: string;
    reason: InboxReason;
    availableAtMs?: number;
  }): InboxItem {
    const conn = this.getConn();
    return conn.transaction(() => {
      this.notifyWithConn(conn, input);
      const rows = conn.prepare(`
        SELECT * FROM agent_inbox
        WHERE agent_id = ? AND target_kind = ? AND target_ref = ? AND reason = ?
        ORDER BY created_at_ms DESC LIMIT 1
      `).all(
        input.agentId,
        input.target.kind,
        chatTargetRef(input.target),
        input.reason,
      ) as InboxRow[];
      if (!rows[0]) throw new Error("inbox notify failed");
      return inboxFromRow(rows[0]);
    })();
  }

  listPending(agentId: string, now = nowMs()): InboxItem[] {
    const rows = this.getConn().prepare(`
      SELECT * FROM agent_inbox
      WHERE agent_id = ? AND status = 'pending' AND available_at_ms <= ?
      ORDER BY available_at_ms, created_at_ms
    `).all(agentId, now) as InboxRow[];
    return rows.map(inboxFromRow);
  }

  listForAgent(agentId: string, status?: InboxStatus): InboxItem[] {
    if (status) {
      const rows = this.getConn().prepare(`
        SELECT * FROM agent_inbox WHERE agent_id = ? AND status = ?
        ORDER BY created_at_ms DESC
      `).all(agentId, status) as InboxRow[];
      return rows.map(inboxFromRow);
    }
    const rows = this.getConn().prepare(`
      SELECT * FROM agent_inbox WHERE agent_id = ? ORDER BY created_at_ms DESC
    `).all(agentId) as InboxRow[];
    return rows.map(inboxFromRow);
  }

  mark(input: { agentId: string; itemId: string; status: Exclude<InboxStatus, "pending"> }): InboxItem {
    const conn = this.getConn();
    return conn.transaction(() => {
      const item = this.require(input.itemId);
      if (item.agentId !== input.agentId) throw new Error("Inbox item not found for Agent");
      conn.prepare("UPDATE agent_inbox SET status = ? WHERE id = ?").run(input.status, input.itemId);
      return this.require(input.itemId);
    })();
  }

  cancelForTarget(agentId: string, target: ChatTarget): void {
    this.getConn().prepare(`
      UPDATE agent_inbox SET status = 'ignored'
      WHERE agent_id = ? AND target_kind = ? AND target_ref = ? AND status = 'pending'
    `).run(agentId, target.kind, chatTargetRef(target));
  }

  private require(id: string): InboxItem {
    const row = this.getConn().prepare("SELECT * FROM agent_inbox WHERE id = ?").get(id) as InboxRow | undefined;
    if (!row) throw new Error(`Inbox item not found: ${id}`);
    return inboxFromRow(row);
  }
}

function inboxFromRow(row: InboxRow): InboxItem {
  return {
    id: row.id,
    agentId: row.agent_id,
    target: chatTargetFromRow(row.target_kind, row.target_ref),
    firstMessageId: row.first_message_id,
    latestMessageId: row.latest_message_id,
    reason: row.reason,
    status: row.status,
    availableAtMs: row.available_at_ms,
    createdAtMs: row.created_at_ms,
  };
}
