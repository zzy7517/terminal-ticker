/**
 * Channel reminders — 一次性提醒的 SQLite 实现。
 * ChannelStore 委托到此模块，避免 store.ts 继续膨胀。
 */
import type Database from "better-sqlite3";
import crypto from "node:crypto";
import { nowMs } from "../db.js";
import type { ChannelReminder, ReminderStatus } from "./domain.js";

export type { ChannelReminder } from "./domain.js";

/** 创建 scheduled 提醒；Channel 必须存在。 */
export function createReminder(
  conn: Database.Database,
  input: {
    agentId: string;
    channelId: string;
    dueAtMs: number;
    note: string;
  },
  channelExists: boolean,
): ChannelReminder {
  if (!Number.isFinite(input.dueAtMs)) throw new Error("dueAtMs is required");
  if (!channelExists) throw new Error("Channel not found");
  return conn.transaction(() => {
    const id = crypto.randomUUID();
    conn.prepare(`
      INSERT INTO channel_reminders (id, agent_id, channel_id, due_at_ms, note, status, created_at_ms)
      VALUES (?, ?, ?, ?, ?, 'scheduled', ?)
    `).run(id, input.agentId, input.channelId, Math.floor(input.dueAtMs), input.note.trim(), nowMs());
    return {
      id,
      agentId: input.agentId,
      channelId: input.channelId,
      dueAtMs: Math.floor(input.dueAtMs),
      note: input.note.trim(),
      status: "scheduled" as const,
    };
  })();
}

/** 取消自己的提醒。 */
export function cancelReminder(
  conn: Database.Database,
  input: { agentId: string; reminderId: string },
): { id: string; status: ReminderStatus } {
  return conn.transaction(() => {
    const row = conn.prepare("SELECT * FROM channel_reminders WHERE id = ?").get(input.reminderId) as {
      id: string;
      agent_id: string;
      status: string;
    } | undefined;
    if (!row || row.agent_id !== input.agentId) throw new Error("Reminder not found");
    conn.prepare("UPDATE channel_reminders SET status = 'cancelled' WHERE id = ?").run(input.reminderId);
    return { id: row.id, status: "cancelled" as const };
  })();
}

/** 列出已到期且仍为 scheduled 的提醒（供 Coordinator 轮询）。 */
export function listDueReminders(
  conn: Database.Database,
  now = nowMs(),
): Array<{ id: string; agentId: string; channelId: string; note: string; dueAtMs: number }> {
  const rows = conn.prepare(`
    SELECT id, agent_id, channel_id, note, due_at_ms
    FROM channel_reminders
    WHERE status = 'scheduled' AND due_at_ms <= ?
    ORDER BY due_at_ms
  `).all(now) as Array<{ id: string; agent_id: string; channel_id: string; note: string; due_at_ms: number }>;
  return rows.map((row) => ({
    id: row.id,
    agentId: row.agent_id,
    channelId: row.channel_id,
    note: row.note,
    dueAtMs: row.due_at_ms,
  }));
}

/** scheduled → triggered 的恰好一次迁移；若已被其他轮询认领则返回 false。 */
export function markReminderTriggered(conn: Database.Database, reminderId: string): boolean {
  const result = conn.prepare(`
    UPDATE channel_reminders SET status = 'triggered'
    WHERE id = ? AND status = 'scheduled'
  `).run(reminderId);
  return result.changes > 0;
}

/** inbox reason 为 reminder 时，供 message_check 读取 note。 */
export function getReminder(conn: Database.Database, reminderId: string): ChannelReminder | null {
  const row = conn.prepare(`
    SELECT id, agent_id, channel_id, note, due_at_ms, status
    FROM channel_reminders WHERE id = ?
  `).get(reminderId) as {
    id: string;
    agent_id: string;
    channel_id: string;
    note: string;
    due_at_ms: number;
    status: string;
  } | undefined;
  if (!row) return null;
  return {
    id: row.id,
    agentId: row.agent_id,
    channelId: row.channel_id,
    note: row.note,
    dueAtMs: row.due_at_ms,
    status: row.status as ReminderStatus,
  };
}
