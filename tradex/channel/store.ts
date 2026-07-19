import Database from "better-sqlite3";
import crypto from "node:crypto";
import path from "node:path";
import { BaseStore, defaultCacheDir, nowMs } from "../db.js";
import { appendChatEvent, initChatEventSchema } from "../chat-events.js";
import {
  channelTarget,
  type Channel,
  type ChannelMessage,
  type ChannelMessageRevision,
  type ChannelReactionSummary,
} from "./domain.js";

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
  thread_root_id: string | null;
  created_at_ms: number;
  edited_at_ms: number | null;
  deleted_at_ms: number | null;
}

interface ChannelMessageRevisionRow {
  message_id: string;
  revision: number;
  content: string;
  action: "edit" | "delete";
  edited_by: string;
  created_at_ms: number;
}

export class ChannelStore extends BaseStore {
  constructor(dbPath = path.join(defaultCacheDir(), "chat.sqlite3")) {
    super(dbPath);
  }

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
        thread_root_id TEXT REFERENCES channel_messages(id),
        created_at_ms INTEGER NOT NULL,
        edited_at_ms INTEGER,
        deleted_at_ms INTEGER,
        UNIQUE (channel_id, channel_seq)
      );
      CREATE INDEX IF NOT EXISTS idx_channel_messages_timeline
        ON channel_messages (channel_id, channel_seq DESC);
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
        role TEXT NOT NULL CHECK (role IN ('member', 'admin')),
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
      // Membership is presence-only; Member/Admin role matrix is deferred.
      conn.prepare(`
        INSERT INTO channel_memberships (channel_id, subject_type, subject_id, role, joined_at_ms)
        VALUES (?, 'human', 'owner', 'member', ?)
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
    threadRootId?: string | null;
    kind?: string;
    onCommitted?: (conn: Database.Database, message: ChannelMessage) => void;
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
    threadRootId?: string | null;
    kind?: string;
    onCommitted?: (conn: Database.Database, message: ChannelMessage) => void;
  }): ChannelMessage {
    return this.appendMessageInternal({
      ...input,
      authorType: "agent",
    });
  }

  private appendMessageInternal(input: {
    channelId: string;
    authorType: "human" | "agent" | "system";
    authorId: string;
    content: string;
    threadRootId?: string | null;
    kind?: string;
    onCommitted?: (conn: Database.Database, message: ChannelMessage) => void;
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
          id, channel_id, channel_seq, author_type, author_id, kind, content, thread_root_id, created_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id,
        input.channelId,
        next.channel_seq,
        input.authorType,
        input.authorId,
        input.kind?.trim() || "message",
        content,
        this.validateThreadRoot(input.channelId, input.threadRootId),
        nowMs(),
      );
      conn.prepare("UPDATE chat_channels SET version = version + 1 WHERE id = ?").run(input.channelId);
      appendChatEvent(conn, {
        type: input.threadRootId ? "thread.reply-created" : "message.created",
        actorType: input.authorType === "system" ? "system" : input.authorType,
        actorId: input.authorId,
        target: channelTarget(input.channelId),
        entityType: "message",
        entityId: id,
        payload: input.threadRootId ? { threadRootId: input.threadRootId } : {},
      });
      const message = this.requireMessage(input.channelId, id);
      input.onCommitted?.(conn, message);
      return message;
    })();
  }

  addMember(input: {
    channelId: string;
    subjectType: "human" | "agent";
    subjectId: string;
  }): { channelId: string; subjectType: string; subjectId: string } {
    const conn = this.getConn();
    return conn.transaction(() => {
      const channel = this.getChannel(input.channelId);
      if (!channel || channel.archivedAtMs !== null) throw new Error("Channel not found");
      // Membership is presence-only for now; Member/Admin role matrix is deferred.
      conn.prepare(`
        INSERT OR REPLACE INTO channel_memberships (channel_id, subject_type, subject_id, role, joined_at_ms)
        VALUES (?, ?, ?, 'member', ?)
      `).run(input.channelId, input.subjectType, input.subjectId, nowMs());
      appendChatEvent(conn, {
        type: "membership.added",
        actorType: "human",
        actorId: "owner",
        target: channelTarget(input.channelId),
        entityType: "membership",
        entityId: `${input.subjectType}:${input.subjectId}`,
      });
      return {
        channelId: input.channelId,
        subjectType: input.subjectType,
        subjectId: input.subjectId,
      };
    })();
  }

  removeMember(input: { channelId: string; subjectType: "human" | "agent"; subjectId: string }): void {
    const conn = this.getConn();
    conn.transaction(() => {
      conn.prepare(`
        DELETE FROM channel_memberships
        WHERE channel_id = ? AND subject_type = ? AND subject_id = ?
      `).run(input.channelId, input.subjectType, input.subjectId);
      appendChatEvent(conn, {
        type: "membership.removed",
        actorType: "human",
        actorId: "owner",
        target: channelTarget(input.channelId),
        entityType: "membership",
        entityId: `${input.subjectType}:${input.subjectId}`,
      });
    })();
  }

  listMembers(channelId: string): Array<{ subjectType: string; subjectId: string; joinedAtMs: number }> {
    const rows = this.getConn().prepare(`
      SELECT subject_type, subject_id, joined_at_ms
      FROM channel_memberships WHERE channel_id = ?
      ORDER BY joined_at_ms
    `).all(channelId) as Array<{ subject_type: string; subject_id: string; joined_at_ms: number }>;
    return rows.map((row) => ({
      subjectType: row.subject_type,
      subjectId: row.subject_id,
      joinedAtMs: row.joined_at_ms,
    }));
  }

  listAgentMemberIds(channelId: string): string[] {
    return this.listMembers(channelId)
      .filter((member) => member.subjectType === "agent")
      .map((member) => member.subjectId);
  }

  createHeldDraft(input: {
    agentId: string;
    channelId: string;
    observedVersion: number;
    content: string;
  }): { id: string; agentId: string; channelId: string; observedVersion: number; content: string; status: string; createdAtMs: number } {
    const conn = this.getConn();
    return conn.transaction(() => {
      const id = crypto.randomUUID();
      const createdAtMs = nowMs();
      conn.prepare(`
        INSERT INTO channel_drafts (
          id, agent_id, channel_id, observed_version, content, status, created_at_ms, resolved_at_ms
        ) VALUES (?, ?, ?, ?, ?, 'held', ?, NULL)
      `).run(id, input.agentId, input.channelId, input.observedVersion, input.content, createdAtMs);
      appendChatEvent(conn, {
        type: "draft.held",
        actorType: "agent",
        actorId: input.agentId,
        target: channelTarget(input.channelId),
        entityType: "draft",
        entityId: id,
      });
      return {
        id,
        agentId: input.agentId,
        channelId: input.channelId,
        observedVersion: input.observedVersion,
        content: input.content,
        status: "held",
        createdAtMs,
      };
    })();
  }

  resolveHeldDraft(input: {
    agentId: string;
    draftId: string;
    action: "retry" | "replace" | "discard";
    content?: string;
  }): {
    draft: { id: string; agentId: string; channelId: string; observedVersion: number; content: string; status: string };
    publishedMessage: ChannelMessage | null;
  } {
    const conn = this.getConn();
    return conn.transaction(() => {
      const row = conn.prepare("SELECT * FROM channel_drafts WHERE id = ?").get(input.draftId) as {
        id: string;
        agent_id: string;
        channel_id: string;
        observed_version: number;
        content: string;
        status: string;
      } | undefined;
      if (!row || row.agent_id !== input.agentId) throw new Error("Held draft not found");
      if (row.status !== "held") throw new Error("draft already resolved");
      if (input.action === "discard") {
        conn.prepare(`
          UPDATE channel_drafts SET status = 'discarded', resolved_at_ms = ? WHERE id = ?
        `).run(nowMs(), input.draftId);
        return {
          draft: {
            id: row.id,
            agentId: row.agent_id,
            channelId: row.channel_id,
            observedVersion: row.observed_version,
            content: row.content,
            status: "discarded",
          },
          publishedMessage: null,
        };
      }
      const content = input.action === "replace" ? String(input.content ?? "").trim() : row.content;
      if (!content) throw new Error("content is required");
      const channel = this.getChannel(row.channel_id);
      if (!channel) throw new Error("Channel not found");
      if (input.action === "retry" && row.observed_version < channel.version) {
        throw new Error("channel changed again; read latest messages before retry");
      }
      const publishedMessage = this.appendAgentMessage({
        channelId: row.channel_id,
        authorId: input.agentId,
        content,
      });
      conn.prepare(`
        UPDATE channel_drafts SET status = 'published', content = ?, resolved_at_ms = ? WHERE id = ?
      `).run(content, nowMs(), input.draftId);
      return {
        draft: {
          id: row.id,
          agentId: row.agent_id,
          channelId: row.channel_id,
          observedVersion: row.observed_version,
          content,
          status: "published",
        },
        publishedMessage,
      };
    })();
  }

  createReminder(input: {
    agentId: string;
    channelId: string;
    dueAtMs: number;
    note: string;
  }): { id: string; agentId: string; channelId: string; dueAtMs: number; note: string; status: string } {
    if (!Number.isFinite(input.dueAtMs)) throw new Error("dueAtMs is required");
    const conn = this.getConn();
    return conn.transaction(() => {
      if (!this.getChannel(input.channelId)) throw new Error("Channel not found");
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
        status: "scheduled",
      };
    })();
  }

  cancelReminder(input: { agentId: string; reminderId: string }): { id: string; status: string } {
    const conn = this.getConn();
    return conn.transaction(() => {
      const row = conn.prepare("SELECT * FROM channel_reminders WHERE id = ?").get(input.reminderId) as {
        id: string;
        agent_id: string;
        status: string;
      } | undefined;
      if (!row || row.agent_id !== input.agentId) throw new Error("Reminder not found");
      conn.prepare("UPDATE channel_reminders SET status = 'cancelled' WHERE id = ?").run(input.reminderId);
      return { id: row.id, status: "cancelled" };
    })();
  }

  listDueReminders(now = nowMs()): Array<{ id: string; agentId: string; channelId: string; note: string; dueAtMs: number }> {
    const rows = this.getConn().prepare(`
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

  markReminderTriggered(reminderId: string): boolean {
    const conn = this.getConn();
    const result = conn.prepare(`
      UPDATE channel_reminders SET status = 'triggered'
      WHERE id = ? AND status = 'scheduled'
    `).run(reminderId);
    return result.changes > 0;
  }

  listMessages(input: { channelId: string; beforeSeq?: number | null; limit?: number }): { messages: ChannelMessage[]; nextBeforeSeq: number | null } {
    const limit = Math.max(1, Math.min(100, Math.floor(input.limit ?? 50)));
    const beforeSeq = input.beforeSeq ?? Number.MAX_SAFE_INTEGER;
    const rows = this.getConn().prepare(`
      SELECT * FROM channel_messages
      WHERE channel_id = ? AND thread_root_id IS NULL AND channel_seq < ?
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

  listThread(input: { channelId: string; rootMessageId: string }): { root: ChannelMessage; replies: ChannelMessage[] } {
    const root = this.requireMessage(input.channelId, input.rootMessageId);
    if (root.threadRootId) throw new Error("Thread root must be a top-level message");
    const rows = this.getConn().prepare(`
      SELECT * FROM channel_messages
      WHERE channel_id = ? AND thread_root_id = ?
      ORDER BY channel_seq
    `).all(input.channelId, input.rootMessageId) as ChannelMessageRow[];
    return { root, replies: rows.map((row) => this.projectMessage(row)) };
  }

  editMessage(input: { channelId: string; messageId: string; actorId: string; content: string }): ChannelMessage {
    const content = input.content.trim();
    if (!content) throw new Error("message content is required");
    const conn = this.getConn();
    return conn.transaction(() => {
      const current = this.requireMessage(input.channelId, input.messageId);
      if (current.deletedAtMs) throw new Error("cannot edit a deleted message");
      if (current.authorType !== "human" || current.authorId !== input.actorId) throw new Error("message edit is not allowed");
      this.saveRevision(current, input.actorId, "edit");
      const editedAtMs = nowMs();
      conn.prepare("UPDATE channel_messages SET content = ?, edited_at_ms = ? WHERE id = ?").run(content, editedAtMs, input.messageId);
      this.bumpChannelVersion(input.channelId);
      appendChatEvent(conn, {
        type: "message.edited",
        actorType: "human",
        actorId: input.actorId,
        target: channelTarget(input.channelId),
        entityType: "message",
        entityId: input.messageId,
      });
      return this.requireMessage(input.channelId, input.messageId);
    })();
  }

  deleteMessage(input: { channelId: string; messageId: string; actorId: string }): ChannelMessage {
    const conn = this.getConn();
    return conn.transaction(() => {
      const current = this.requireMessage(input.channelId, input.messageId);
      if (current.deletedAtMs) return current;
      if (current.authorType !== "human" || current.authorId !== input.actorId) throw new Error("message delete is not allowed");
      this.saveRevision(current, input.actorId, "delete");
      const deletedAtMs = nowMs();
      conn.prepare("UPDATE channel_messages SET content = '', deleted_at_ms = ? WHERE id = ?").run(deletedAtMs, input.messageId);
      this.bumpChannelVersion(input.channelId);
      appendChatEvent(conn, {
        type: "message.deleted",
        actorType: "human",
        actorId: input.actorId,
        target: channelTarget(input.channelId),
        entityType: "message",
        entityId: input.messageId,
      });
      return this.requireMessage(input.channelId, input.messageId);
    })();
  }

  listRevisions(input: { channelId: string; messageId: string }): ChannelMessageRevision[] {
    this.requireMessage(input.channelId, input.messageId);
    const rows = this.getConn().prepare(`
      SELECT * FROM channel_message_revisions WHERE message_id = ? ORDER BY revision
    `).all(input.messageId) as ChannelMessageRevisionRow[];
    return rows.map((row) => ({
      messageId: row.message_id,
      revision: row.revision,
      content: row.content,
      action: row.action,
      editedBy: row.edited_by,
      createdAtMs: row.created_at_ms,
    }));
  }

  addReaction(input: { channelId: string; messageId: string; actorId: string; emoji: string }): ChannelMessage {
    const emoji = normalizeEmoji(input.emoji);
    const conn = this.getConn();
    return conn.transaction(() => {
      this.requireMessage(input.channelId, input.messageId);
      const result = conn.prepare(`
        INSERT OR IGNORE INTO channel_reactions (message_id, actor_type, actor_id, emoji, created_at_ms)
        VALUES (?, 'human', ?, ?, ?)
      `).run(input.messageId, input.actorId, emoji, nowMs());
      if (result.changes > 0) {
        this.bumpChannelVersion(input.channelId);
        appendChatEvent(conn, {
          type: "reaction.added",
          actorType: "human",
          actorId: input.actorId,
          target: channelTarget(input.channelId),
          entityType: "message",
          entityId: input.messageId,
          payload: { emoji },
        });
      }
      return this.requireMessage(input.channelId, input.messageId);
    })();
  }

  removeReaction(input: { channelId: string; messageId: string; actorId: string; emoji: string }): ChannelMessage {
    const emoji = normalizeEmoji(input.emoji);
    const conn = this.getConn();
    return conn.transaction(() => {
      this.requireMessage(input.channelId, input.messageId);
      const result = conn.prepare(`
        DELETE FROM channel_reactions
        WHERE message_id = ? AND actor_type = 'human' AND actor_id = ? AND emoji = ?
      `).run(input.messageId, input.actorId, emoji);
      if (result.changes > 0) {
        this.bumpChannelVersion(input.channelId);
        appendChatEvent(conn, {
          type: "reaction.removed",
          actorType: "human",
          actorId: input.actorId,
          target: channelTarget(input.channelId),
          entityType: "message",
          entityId: input.messageId,
          payload: { emoji },
        });
      }
      return this.requireMessage(input.channelId, input.messageId);
    })();
  }

  private validateThreadRoot(channelId: string, threadRootId: string | null | undefined): string | null {
    if (!threadRootId) return null;
    const root = this.requireMessage(channelId, threadRootId);
    if (root.threadRootId) throw new Error("Thread root must be a top-level message");
    return root.id;
  }

  private saveRevision(message: ChannelMessage, actorId: string, action: "edit" | "delete"): void {
    const conn = this.getConn();
    const next = conn.prepare(`
      SELECT COALESCE(MAX(revision), 0) + 1 AS revision
      FROM channel_message_revisions WHERE message_id = ?
    `).get(message.id) as { revision: number };
    conn.prepare(`
      INSERT INTO channel_message_revisions (message_id, revision, content, action, edited_by, created_at_ms)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(message.id, next.revision, message.content, action, actorId, nowMs());
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
    const replyCount = (this.getConn().prepare(
      "SELECT COUNT(*) AS count FROM channel_messages WHERE thread_root_id = ?",
    ).get(row.id) as { count: number }).count;
    const reactions = this.getConn().prepare(`
      SELECT emoji, COUNT(*) AS count,
        MAX(CASE WHEN actor_type = 'human' AND actor_id = 'owner' THEN 1 ELSE 0 END) AS reacted
      FROM channel_reactions WHERE message_id = ? GROUP BY emoji ORDER BY emoji
    `).all(row.id) as Array<{ emoji: string; count: number; reacted: number }>;
    return messageFromRow(row, replyCount, reactions.map((reaction): ChannelReactionSummary => ({
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

function messageFromRow(row: ChannelMessageRow, replyCount: number, reactions: ChannelReactionSummary[]): ChannelMessage {
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
    editedAtMs: row.edited_at_ms,
    deletedAtMs: row.deleted_at_ms,
    replyCount,
    reactions,
  };
}

function normalizeEmoji(value: string): string {
  const emoji = value.trim();
  if (!emoji || emoji.length > 32) throw new Error("emoji is required");
  return emoji;
}

function ensureColumn(conn: Database.Database, table: string, column: string, definition: string): void {
  const columns = conn.pragma(`table_info(${table})`) as Array<{ name: string }>;
  if (!columns.some((entry) => entry.name === column)) {
    conn.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
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
        thread_root_id TEXT REFERENCES channel_messages(id),
        created_at_ms INTEGER NOT NULL,
        edited_at_ms INTEGER,
        deleted_at_ms INTEGER,
        UNIQUE (channel_id, channel_seq)
      );
      INSERT INTO channel_messages_next (
        id, channel_id, channel_seq, author_type, author_id, kind, content,
        thread_root_id, created_at_ms, edited_at_ms, deleted_at_ms
      )
      SELECT id, channel_id, channel_seq, author_type, author_id, kind, content,
        thread_root_id, created_at_ms, edited_at_ms, deleted_at_ms
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
