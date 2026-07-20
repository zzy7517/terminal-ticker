/**
 * ChannelStore — Channel 元数据与消息时间线的权威存储门面。
 *
 * membership / held-drafts / reminders / reactions 委托到同级 Module；
 * 每次消息变更递增 Channel version，并驱动 held-draft 冲突检测。
 */
import Database from "better-sqlite3";
import crypto from "node:crypto";
import path from "node:path";
import { BaseStore, defaultCacheDir, nowMs } from "../db.js";
import { appendChatEvent, initChatEventSchema } from "../chat/events.js";
import { nullOutLegacyColumn } from "../chat/legacy-schema.js";
import {
  channelTarget,
  type Channel,
  type ChannelMessage,
  type ChannelReactionSummary,
} from "./domain.js";
import * as heldDrafts from "./held-drafts.js";
import * as membership from "./membership.js";
import * as reactions from "./reactions.js";
import * as reminders from "./reminders.js";

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
  kind: string;
  content: string;
  created_at_ms: number;
  edited_at_ms: number | null;
  deleted_at_ms: number | null;
}

/**
 * ChannelStore — Channel 消息、成员、Held Draft、Reminder 的权威存储。
 *
 * 对应 Raft Server 下的 Channels：共享可见事实落库于此；
 * Agent 私有上下文在 Agent Context / workspace，不在本 Store。
 */
export class ChannelStore extends BaseStore {
  constructor(dbPath = path.join(defaultCacheDir(), "chat.sqlite3")) {
    super(dbPath);
  }

  // --- Channel / 消息 -------------------------------------------------

  protected override initSchema(conn: Database.Database): void {
    initChatEventSchema(conn);
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
        kind TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL,
        edited_at_ms INTEGER,
        deleted_at_ms INTEGER,
        UNIQUE (channel_id, channel_seq)
      );
      CREATE INDEX IF NOT EXISTS idx_channel_messages_timeline
        ON channel_messages (channel_id, channel_seq DESC);
      -- Legacy: product no longer supports message edit/delete; table kept for existing DBs.
      CREATE TABLE IF NOT EXISTS channel_message_revisions (
        message_id TEXT NOT NULL REFERENCES channel_messages(id) ON DELETE CASCADE,
        revision INTEGER NOT NULL,
        content TEXT NOT NULL,
        action TEXT NOT NULL CHECK (action IN ('edit', 'delete')),
        edited_by TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL,
        PRIMARY KEY (message_id, revision)
      );
      CREATE TABLE IF NOT EXISTS channel_reactions (
        message_id TEXT NOT NULL REFERENCES channel_messages(id) ON DELETE CASCADE,
        actor_type TEXT NOT NULL CHECK (actor_type IN ('human', 'agent')),
        actor_id TEXT NOT NULL,
        emoji TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL,
        PRIMARY KEY (message_id, actor_type, actor_id, emoji)
      );
      CREATE TABLE IF NOT EXISTS channel_memberships (
        channel_id TEXT NOT NULL REFERENCES chat_channels(id) ON DELETE CASCADE,
        subject_type TEXT NOT NULL CHECK (subject_type IN ('human', 'agent')),
        subject_id TEXT NOT NULL,
        joined_at_ms INTEGER NOT NULL,
        PRIMARY KEY (channel_id, subject_type, subject_id)
      );
      CREATE TABLE IF NOT EXISTS channel_drafts (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        channel_id TEXT NOT NULL REFERENCES chat_channels(id) ON DELETE CASCADE,
        observed_version INTEGER NOT NULL,
        content TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('held', 'published', 'discarded')),
        created_at_ms INTEGER NOT NULL,
        resolved_at_ms INTEGER
      );
      CREATE TABLE IF NOT EXISTS channel_reminders (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        channel_id TEXT NOT NULL REFERENCES chat_channels(id) ON DELETE CASCADE,
        due_at_ms INTEGER NOT NULL,
        note TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('scheduled', 'triggered', 'cancelled')),
        created_at_ms INTEGER NOT NULL
      );
    `);
    ensureColumn(conn, "channel_messages", "edited_at_ms", "INTEGER");
    ensureColumn(conn, "channel_messages", "deleted_at_ms", "INTEGER");
    ensureMessageKindForwardCompatible(conn);
    ensureMembershipSchema(conn);
    nullOutLegacyColumn(conn, "channel_messages", "thread_root_id");
    conn.exec(`
      CREATE INDEX IF NOT EXISTS idx_channel_messages_timeline
        ON channel_messages (channel_id, channel_seq DESC);
    `);
  }

  createChannel(input: { name: string; topic?: string; visibility?: "public" | "private" }): Channel {
    const name = normalizeChannelName(input.name);
    const id = crypto.randomUUID();
    const conn = this.getConn();
    return conn.transaction(() => {
      conn.prepare(`
        INSERT INTO chat_channels (id, name, topic, visibility, version, created_at_ms, archived_at_ms)
        VALUES (?, ?, ?, ?, 0, ?, NULL)
      `).run(id, name, input.topic?.trim() ?? "", input.visibility ?? "public", nowMs());
      conn.prepare(`
        INSERT INTO channel_memberships (channel_id, subject_type, subject_id, joined_at_ms)
        VALUES (?, 'human', 'owner', ?)
      `).run(id, nowMs());
      appendChatEvent(conn, {
        type: "channel.created",
        actorType: "human",
        actorId: "owner",
        target: channelTarget(id),
        entityType: "channel",
        entityId: id,
        payload: { name },
      });
      return this.getChannel(id)!;
    })();
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

  updateChannel(id: string, input: { name?: string; topic?: string; visibility?: "public" | "private" }): Channel {
    const conn = this.getConn();
    return conn.transaction(() => {
      const current = this.getChannel(id);
      if (!current || current.archivedAtMs !== null) throw new Error("Channel not found");
      const name = input.name === undefined ? current.name : normalizeChannelName(input.name);
      const topic = input.topic === undefined ? current.topic : input.topic.trim();
      const visibility = input.visibility ?? current.visibility;
      conn.prepare(`
        UPDATE chat_channels
        SET name = ?, topic = ?, visibility = ?, version = version + 1
        WHERE id = ?
      `).run(name, topic, visibility, id);
      appendChatEvent(conn, {
        type: "channel.updated",
        actorType: "human",
        actorId: "owner",
        target: channelTarget(id),
        entityType: "channel",
        entityId: id,
      });
      return this.getChannel(id)!;
    })();
  }

  archiveChannel(id: string): Channel {
    const conn = this.getConn();
    return conn.transaction(() => {
      const current = this.getChannel(id);
      if (!current) throw new Error("Channel not found");
      if (current.archivedAtMs !== null) return current;
      conn.prepare(`
        UPDATE chat_channels SET archived_at_ms = ?, version = version + 1 WHERE id = ?
      `).run(nowMs(), id);
      appendChatEvent(conn, {
        type: "channel.archived",
        actorType: "human",
        actorId: "owner",
        target: channelTarget(id),
        entityType: "channel",
        entityId: id,
      });
      return this.getChannel(id)!;
    })();
  }

  appendMessage(input: {
    channelId: string;
    authorId: string;
    content: string;
    kind?: string;
    withinTransaction?: (conn: Database.Database, message: ChannelMessage) => void;
  }): ChannelMessage {
    return this.appendMessageInternal({
      ...input,
      authorType: "human",
    });
  }

  appendAgentMessage(input: {
    channelId: string;
    authorId: string;
    content: string;
    kind?: string;
    withinTransaction?: (conn: Database.Database, message: ChannelMessage) => void;
  }): ChannelMessage {
    return this.appendMessageInternal({
      ...input,
      authorType: "agent",
    });
  }

  /** 系统通知（如因果链暂停）；会递增 Channel version。 */
  appendSystemMessage(input: {
    channelId: string;
    content: string;
    kind?: string;
  }): ChannelMessage {
    return this.appendMessageInternal({
      channelId: input.channelId,
      authorType: "system",
      authorId: "system",
      content: input.content,
      kind: input.kind ?? "system",
    });
  }

  private appendMessageInternal(input: {
    channelId: string;
    authorType: "human" | "agent" | "system";
    authorId: string;
    content: string;
    kind?: string;
    withinTransaction?: (conn: Database.Database, message: ChannelMessage) => void;
  }): ChannelMessage {
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
          id, channel_id, channel_seq, author_type, author_id, kind, content, created_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id,
        input.channelId,
        next.channel_seq,
        input.authorType,
        input.authorId,
        input.kind?.trim() || "message",
        content,
        nowMs(),
      );
      conn.prepare("UPDATE chat_channels SET version = version + 1 WHERE id = ?").run(input.channelId);
      appendChatEvent(conn, {
        type: "message.created",
        actorType: input.authorType === "system" ? "system" : input.authorType,
        actorId: input.authorId,
        target: channelTarget(input.channelId),
        entityType: "message",
        entityId: id,
        payload: {},
      });
      const message = this.requireMessage(input.channelId, id);
      input.withinTransaction?.(conn, message);
      return message;
    })();
  }

  /** 添加或替换成员。 */
  addMember(input: {
    channelId: string;
    subjectType: "human" | "agent";
    subjectId: string;
  }): { channelId: string; subjectType: string; subjectId: string } {
    return membership.addMember(this.getConn(), input, (channelId) => this.getChannel(channelId));
  }

  removeMember(input: { channelId: string; subjectType: "human" | "agent"; subjectId: string }): void {
    membership.removeMember(this.getConn(), input);
  }

  listMembers(channelId: string): Array<{ subjectType: string; subjectId: string; joinedAtMs: number }> {
    return membership.listMembers(this.getConn(), channelId);
  }

  listAgentMemberIds(channelId: string): string[] {
    return membership.listAgentMemberIds(this.getConn(), channelId);
  }

  /**
   * 当 Agent 的 observedVersion 落后于 channel.version 时暂存回复。
   * 不会直接发布；Agent 需通过 retry/replace/discard 解决。
   */
  createHeldDraft(input: {
    agentId: string;
    channelId: string;
    observedVersion: number;
    content: string;
  }): heldDrafts.HeldDraft {
    return heldDrafts.createHeldDraft(this.getConn(), input);
  }

  /**
   * 解决 held draft。retry/replace 经 appendAgentMessage 发布；
   * 调用方发布后还需 dispatchSharedMessage 做 inbox fan-out。
   */
  resolveHeldDraft(input: {
    agentId: string;
    draftId: string;
    action: "retry" | "replace" | "discard";
    content?: string;
  }): {
    draft: Omit<heldDrafts.HeldDraft, "createdAtMs">;
    publishedMessage: ChannelMessage | null;
  } {
    return heldDrafts.resolveHeldDraft(this.getConn(), input, {
      getChannel: (channelId) => this.getChannel(channelId),
      appendAgentMessage: (payload) => this.appendAgentMessage(payload),
    });
  }

  /** 为 Agent 在 Channel 上安排一次性 reminder（不是 Cron Job）。 */
  createReminder(input: {
    agentId: string;
    channelId: string;
    dueAtMs: number;
    note: string;
  }): reminders.ChannelReminder {
    return reminders.createReminder(this.getConn(), input, Boolean(this.getChannel(input.channelId)));
  }

  cancelReminder(input: { agentId: string; reminderId: string }): { id: string; status: string } {
    return reminders.cancelReminder(this.getConn(), input);
  }

  listDueReminders(now = nowMs()): Array<{ id: string; agentId: string; channelId: string; note: string; dueAtMs: number }> {
    return reminders.listDueReminders(this.getConn(), now);
  }

  /**
   * scheduled → triggered 的恰好一次迁移。
   * 若已被其他轮询认领则返回 false。
   */
  markReminderTriggered(reminderId: string): boolean {
    return reminders.markReminderTriggered(this.getConn(), reminderId);
  }

  /** inbox reason 为 reminder 时，供 message_check 读取 note。 */
  getReminder(reminderId: string): reminders.ChannelReminder | null {
    return reminders.getReminder(this.getConn(), reminderId);
  }

  listHeldDrafts(channelId: string): heldDrafts.HeldDraft[] {
    return heldDrafts.listHeldDrafts(this.getConn(), channelId);
  }

  /**
   * Agent 读取 Channel 后，把其 held draft 的 observed_version 推进到 reviewedVersion。
   * 这样后续 retry/replace 在房间未再变化时可发布。
   */
  markHeldDraftsReviewed(input: {
    agentId: string;
    channelId: string;
    reviewedVersion: number;
  }): number {
    return heldDrafts.markHeldDraftsReviewed(this.getConn(), input);
  }

  /**
   * Human Owner 在 draft 持有超过 graceMs 后可 discard；不能代 Agent 发布。
   */
  humanDiscardHeldDraft(input: {
    draftId: string;
    graceMs?: number;
    now?: number;
  }): { id: string; agentId: string; channelId: string; status: string; createdAtMs: number } {
    return heldDrafts.humanDiscardHeldDraft(this.getConn(), input);
  }

  /** 统计 Human 已读游标之后的顶层消息数。 */
  countMessagesAfterSeq(channelId: string, afterSeq: number): number {
    const row = this.getConn().prepare(`
      SELECT COUNT(*) AS count FROM channel_messages
      WHERE channel_id = ? AND channel_seq > ?
        AND deleted_at_ms IS NULL
    `).get(channelId, afterSeq) as { count: number };
    return Number(row.count) || 0;
  }

  listMessages(input: {
    channelId: string;
    beforeSeq?: number | null;
    afterSeq?: number | null;
    aroundMessageId?: string | null;
    limit?: number;
  }): { messages: ChannelMessage[]; nextBeforeSeq: number | null } {
    const limit = Math.max(1, Math.min(100, Math.floor(input.limit ?? 50)));
    if (input.aroundMessageId) {
      const pivot = this.getMessage(input.aroundMessageId);
      if (!pivot || pivot.channelId !== input.channelId) throw new Error("around message not found");
      const beforeLimit = Math.floor(limit / 2);
      const afterLimit = Math.max(1, limit - beforeLimit - 1);
      const before = this.listMessages({
        channelId: input.channelId,
        beforeSeq: pivot.channelSeq,
        limit: beforeLimit,
      }).messages.reverse();
      const after = this.listMessages({
        channelId: input.channelId,
        afterSeq: pivot.channelSeq,
        limit: afterLimit,
      }).messages;
      return {
        messages: [...before, pivot, ...after],
        nextBeforeSeq: before[0]?.channelSeq ?? null,
      };
    }
    if (input.afterSeq != null) {
      const rows = this.getConn().prepare(`
        SELECT * FROM channel_messages
        WHERE channel_id = ? AND channel_seq > ?
        ORDER BY channel_seq
        LIMIT ?
      `).all(input.channelId, input.afterSeq, limit) as ChannelMessageRow[];
      return {
        messages: rows.map((row) => this.projectMessage(row)),
        nextBeforeSeq: null,
      };
    }
    const beforeSeq = input.beforeSeq ?? Number.MAX_SAFE_INTEGER;
    const rows = this.getConn().prepare(`
      SELECT * FROM channel_messages
      WHERE channel_id = ? AND channel_seq < ?
      ORDER BY channel_seq DESC
      LIMIT ?
    `).all(input.channelId, beforeSeq, limit) as ChannelMessageRow[];
    return {
      messages: rows.map((row) => this.projectMessage(row)),
      nextBeforeSeq: rows.length === limit ? rows.at(-1)!.channel_seq : null,
    };
  }

  getMessage(id: string): ChannelMessage | null {
    const row = this.getConn().prepare("SELECT * FROM channel_messages WHERE id = ?").get(id) as ChannelMessageRow | undefined;
    return row ? this.projectMessage(row) : null;
  }

  addReaction(input: {
    channelId: string;
    messageId: string;
    actorId: string;
    emoji: string;
    actorType?: "human" | "agent";
  }): ChannelMessage {
    return reactions.addReaction(this.getConn(), input, {
      requireMessage: (channelId, messageId) => this.requireMessage(channelId, messageId),
      bumpChannelVersion: (channelId) => this.bumpChannelVersion(channelId),
    });
  }

  removeReaction(input: {
    channelId: string;
    messageId: string;
    actorId: string;
    emoji: string;
    actorType?: "human" | "agent";
  }): ChannelMessage {
    return reactions.removeReaction(this.getConn(), input, {
      requireMessage: (channelId, messageId) => this.requireMessage(channelId, messageId),
      bumpChannelVersion: (channelId) => this.bumpChannelVersion(channelId),
    });
  }

  private bumpChannelVersion(channelId: string): void {
    this.getConn().prepare("UPDATE chat_channels SET version = version + 1 WHERE id = ?").run(channelId);
  }

  private requireMessage(channelId: string, id: string): ChannelMessage {
    const row = this.getConn().prepare("SELECT * FROM channel_messages WHERE id = ? AND channel_id = ?").get(id, channelId) as ChannelMessageRow | undefined;
    if (!row) throw new Error(`Message not found: ${id}`);
    return this.projectMessage(row);
  }

  private projectMessage(row: ChannelMessageRow): ChannelMessage {
    const reactions = this.getConn().prepare(`
      SELECT emoji, COUNT(*) AS count,
        MAX(CASE WHEN actor_type = 'human' AND actor_id = 'owner' THEN 1 ELSE 0 END) AS reacted
      FROM channel_reactions WHERE message_id = ? GROUP BY emoji ORDER BY emoji
    `).all(row.id) as Array<{ emoji: string; count: number; reacted: number }>;
    return messageFromRow(row, reactions.map((reaction): ChannelReactionSummary => ({
      emoji: reaction.emoji,
      count: reaction.count,
      reacted: Boolean(reaction.reacted),
    })));
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

function messageFromRow(row: ChannelMessageRow, reactions: ChannelReactionSummary[]): ChannelMessage {
  return {
    id: row.id,
    channelId: row.channel_id,
    channelSeq: row.channel_seq,
    authorType: row.author_type,
    authorId: row.author_id,
    kind: row.kind,
    content: row.content,
    createdAtMs: row.created_at_ms,
    editedAtMs: row.edited_at_ms,
    deletedAtMs: row.deleted_at_ms,
    reactions,
  };
}

function ensureColumn(conn: Database.Database, table: string, column: string, definition: string): void {
  const columns = conn.pragma(`table_info(${table})`) as Array<{ name: string }>;
  if (!columns.some((entry) => entry.name === column)) {
    conn.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

/** Rebuild channel_memberships when its columns diverge from (channel_id, subject_type, subject_id, joined_at_ms). */
function ensureMembershipSchema(conn: Database.Database): void {
  const columns = conn.pragma("table_info(channel_memberships)") as Array<{ name: string }>;
  if (columns.length === 0) return;
  const expected = new Set(["channel_id", "subject_type", "subject_id", "joined_at_ms"]);
  const names = new Set(columns.map((entry) => entry.name));
  if (names.size === expected.size && [...expected].every((name) => names.has(name))) return;
  conn.pragma("foreign_keys = OFF");
  try {
    conn.exec(`
      BEGIN;
      CREATE TABLE channel_memberships_next (
        channel_id TEXT NOT NULL REFERENCES chat_channels(id) ON DELETE CASCADE,
        subject_type TEXT NOT NULL CHECK (subject_type IN ('human', 'agent')),
        subject_id TEXT NOT NULL,
        joined_at_ms INTEGER NOT NULL,
        PRIMARY KEY (channel_id, subject_type, subject_id)
      );
      INSERT INTO channel_memberships_next (channel_id, subject_type, subject_id, joined_at_ms)
      SELECT channel_id, subject_type, subject_id, joined_at_ms FROM channel_memberships;
      DROP TABLE channel_memberships;
      ALTER TABLE channel_memberships_next RENAME TO channel_memberships;
      COMMIT;
    `);
  } catch (error) {
    if (conn.inTransaction) conn.exec("ROLLBACK");
    throw error;
  } finally {
    conn.pragma("foreign_keys = ON");
  }
}

function ensureMessageKindForwardCompatible(conn: Database.Database): void {
  const schema = conn.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'channel_messages'")
    .get() as { sql: string } | undefined;
  if (!schema?.sql.includes("CHECK (kind IN")) return;
  conn.pragma("foreign_keys = OFF");
  try {
    conn.exec(`
      BEGIN;
      CREATE TABLE channel_messages_next (
        id TEXT PRIMARY KEY,
        channel_id TEXT NOT NULL REFERENCES chat_channels(id) ON DELETE CASCADE,
        channel_seq INTEGER NOT NULL,
        author_type TEXT NOT NULL CHECK (author_type IN ('human', 'agent', 'system')),
        author_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL,
        edited_at_ms INTEGER,
        deleted_at_ms INTEGER,
        UNIQUE (channel_id, channel_seq)
      );
      INSERT INTO channel_messages_next (
        id, channel_id, channel_seq, author_type, author_id, kind, content,
        created_at_ms, edited_at_ms, deleted_at_ms
      )
      SELECT id, channel_id, channel_seq, author_type, author_id, kind, content,
        created_at_ms, edited_at_ms, deleted_at_ms
      FROM channel_messages;
      DROP TABLE channel_messages;
      ALTER TABLE channel_messages_next RENAME TO channel_messages;
      COMMIT;
    `);
  } catch (error) {
    if (conn.inTransaction) conn.exec("ROLLBACK");
    throw error;
  } finally {
    conn.pragma("foreign_keys = ON");
  }
}
