/**
 * MessageStore — Direct Message 会话与消息的权威存储。
 *
 * 规范化后的参与者组合对应唯一一条 DM。Runtime Session 不是 DM timeline 的权威来源，
 * 只保存 Agent 私有执行历史。遗留 Session 导入用 import_key 保证幂等，
 * 原始 Session 文件保留为执行归档。
 */
import Database from "better-sqlite3";
import crypto from "node:crypto";
import path from "node:path";
import { BaseStore, defaultCacheDir, nowMs } from "../db.js";
import { appendChatEvent, initChatEventSchema } from "./events.js";
import { nullOutLegacyColumn } from "./legacy-schema.js";
import { directMessageTarget } from "./target.js";
import { migrateLegacyDirectChatTargets as rewriteLegacyDirectChatTargets } from "./migrate-legacy-targets.js";

/** Human–Agent DM 中稳定的 Human Owner 参与者 ID。 */
export const HUMAN_OWNER_ID = "owner";

/** Human / Agent 参与者类型。 */
export type ParticipantType = "human" | "agent";

/** 唯一一对参与者之间的 Direct Message 会话。 */
export interface DirectMessageConversation {
  id: string;
  participantAType: ParticipantType;
  participantAId: string;
  participantBType: ParticipantType;
  participantBId: string;
  createdAtMs: number;
}

/** Direct Message 共享消息正文（权威在 MessageStore）。 */
export interface DirectMessage {
  id: string;
  directMessageId: string;
  dmSeq: number;
  authorType: "human" | "agent" | "system";
  authorId: string;
  kind: string;
  content: string;
  createdAtMs: number;
  editedAtMs: number | null;
  deletedAtMs: number | null;
  importKey: string | null;
  reactions: Array<{ emoji: string; count: number; reacted: boolean }>;
}

interface ConversationRow {
  id: string;
  participant_a_type: ParticipantType;
  participant_a_id: string;
  participant_b_type: ParticipantType;
  participant_b_id: string;
  created_at_ms: number;
}

interface MessageRow {
  id: string;
  direct_message_id: string;
  dm_seq: number;
  author_type: DirectMessage["authorType"];
  author_id: string;
  kind: string;
  content: string;
  created_at_ms: number;
  edited_at_ms: number | null;
  deleted_at_ms: number | null;
  import_key: string | null;
}

interface NormalizedPair {
  aType: ParticipantType;
  aId: string;
  bType: ParticipantType;
  bId: string;
}

/** Direct Message 权威库：会话唯一性、消息、reaction、遗留导入。 */
export class MessageStore extends BaseStore {
  constructor(dbPath = path.join(defaultCacheDir(), "chat.sqlite3")) {
    super(dbPath);
  }

  protected override initSchema(conn: Database.Database): void {
    initChatEventSchema(conn);
    migrateChatEventTargetKinds(conn);
    nullOutLegacyColumn(conn, "direct_messages", "thread_root_id");
    conn.exec(`
      CREATE TABLE IF NOT EXISTS direct_message_conversations (
        id TEXT PRIMARY KEY,
        participant_a_type TEXT NOT NULL CHECK (participant_a_type IN ('human', 'agent')),
        participant_a_id TEXT NOT NULL,
        participant_b_type TEXT NOT NULL CHECK (participant_b_type IN ('human', 'agent')),
        participant_b_id TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL,
        UNIQUE (participant_a_type, participant_a_id, participant_b_type, participant_b_id)
      );
      CREATE TABLE IF NOT EXISTS direct_messages (
        id TEXT PRIMARY KEY,
        direct_message_id TEXT NOT NULL REFERENCES direct_message_conversations(id) ON DELETE CASCADE,
        dm_seq INTEGER NOT NULL,
        author_type TEXT NOT NULL CHECK (author_type IN ('human', 'agent', 'system')),
        author_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL,
        edited_at_ms INTEGER,
        deleted_at_ms INTEGER,
        import_key TEXT,
        UNIQUE (direct_message_id, dm_seq),
        UNIQUE (import_key)
      );
      CREATE INDEX IF NOT EXISTS idx_direct_messages_timeline
        ON direct_messages (direct_message_id, dm_seq DESC);
      CREATE TABLE IF NOT EXISTS direct_message_reactions (
        message_id TEXT NOT NULL REFERENCES direct_messages(id) ON DELETE CASCADE,
        actor_type TEXT NOT NULL CHECK (actor_type IN ('human', 'agent')),
        actor_id TEXT NOT NULL,
        emoji TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL,
        PRIMARY KEY (message_id, actor_type, actor_id, emoji)
      );
    `);
  }

  /** 侧栏按 agentId 导航的唯一 Human–Agent DM。 */
  ensureHumanAgentDm(agentId: string): DirectMessageConversation {
    return this.ensureConversation({
      left: { type: "human", id: HUMAN_OWNER_ID },
      right: { type: "agent", id: agentId },
    });
  }

  /** 唯一 Agent–Agent DM；参与者顺序会规范化以保证唯一。 */
  ensureAgentAgentDm(agentAId: string, agentBId: string): DirectMessageConversation {
    if (agentAId === agentBId) throw new Error("cannot create DM with the same Agent");
    return this.ensureConversation({
      left: { type: "agent", id: agentAId },
      right: { type: "agent", id: agentBId },
    });
  }

  getConversation(id: string): DirectMessageConversation | null {
    const row = this.getConn().prepare(
      "SELECT * FROM direct_message_conversations WHERE id = ?",
    ).get(id) as ConversationRow | undefined;
    return row ? conversationFromRow(row) : null;
  }

  humanAgentDmForAgent(agentId: string): DirectMessageConversation | null {
    const pair = normalizePair(
      { type: "human", id: HUMAN_OWNER_ID },
      { type: "agent", id: agentId },
    );
    const row = this.getConn().prepare(`
      SELECT * FROM direct_message_conversations
      WHERE participant_a_type = ? AND participant_a_id = ?
        AND participant_b_type = ? AND participant_b_id = ?
    `).get(pair.aType, pair.aId, pair.bType, pair.bId) as ConversationRow | undefined;
    return row ? conversationFromRow(row) : null;
  }

  /** 包含该 Agent 的全部 DM（Human-Agent 与 Agent-Agent）。 */
  listConversationsForAgent(agentId: string): DirectMessageConversation[] {
    const rows = this.getConn().prepare(`
      SELECT * FROM direct_message_conversations
      WHERE (participant_a_type = 'agent' AND participant_a_id = ?)
         OR (participant_b_type = 'agent' AND participant_b_id = ?)
      ORDER BY created_at_ms
    `).all(agentId, agentId) as ConversationRow[];
    return rows.map(conversationFromRow);
  }

  /** 将 Human UI 的 agentId 导航解析为唯一 Human-Agent DM。 */
  requireHumanAgentDm(agentId: string): DirectMessageConversation {
    return this.ensureHumanAgentDm(agentId);
  }

  /** 启动时把遗留 direct-chat 行改写为真实 direct-message id。 */
  migrateLegacyDirectChatTargets(): number {
    return rewriteLegacyDirectChatTargets(
      this.getConn(),
      (agentId) => this.ensureHumanAgentDm(agentId).id,
    );
  }

  otherParticipant(conversation: DirectMessageConversation, actorType: ParticipantType, actorId: string): {
    type: ParticipantType;
    id: string;
  } | null {
    const a = { type: conversation.participantAType, id: conversation.participantAId };
    const b = { type: conversation.participantBType, id: conversation.participantBId };
    if (a.type === actorType && a.id === actorId) return b;
    if (b.type === actorType && b.id === actorId) return a;
    return null;
  }

  /**
   * 追加一条 DM 消息。可选 withinTransaction 在同一事务内执行（如 inbox fan-out），
   * 保证消息与注意力队列原子提交。
   * 使 inbox fan-out 与消息写入保持原子。
   * importKey 用于遗留 Session 导入幂等。
   */
  appendMessage(input: {
    directMessageId: string;
    authorType: DirectMessage["authorType"];
    authorId: string;
    content: string;
    kind?: string;
    createdAtMs?: number;
    importKey?: string | null;
    withinTransaction?: (conn: Database.Database, message: DirectMessage) => void;
  }): DirectMessage {
    const content = input.content.trim();
    if (!content && input.kind !== "system") throw new Error("message content is required");
    const conn = this.getConn();
    return conn.transaction(() => {
      const conversation = this.getConversation(input.directMessageId);
      if (!conversation) throw new Error("Direct Message not found");
      if (input.importKey) {
        const existing = conn.prepare(
          "SELECT * FROM direct_messages WHERE import_key = ?",
        ).get(input.importKey) as MessageRow | undefined;
        if (existing) return this.projectMessage(existing.id, null);
      }
      const next = conn.prepare(`
        SELECT COALESCE(MAX(dm_seq), 0) + 1 AS dm_seq
        FROM direct_messages WHERE direct_message_id = ?
      `).get(input.directMessageId) as { dm_seq: number };
      const id = crypto.randomUUID();
      const createdAtMs = input.createdAtMs ?? nowMs();
      conn.prepare(`
        INSERT INTO direct_messages (
          id, direct_message_id, dm_seq, author_type, author_id, kind, content,
          created_at_ms, edited_at_ms, deleted_at_ms, import_key
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?)
      `).run(
        id,
        input.directMessageId,
        next.dm_seq,
        input.authorType,
        input.authorId,
        input.kind?.trim() || "message",
        content,
        createdAtMs,
        input.importKey ?? null,
      );
      appendChatEvent(conn, {
        type: "message.created",
        actorType: input.authorType === "system" ? "system" : input.authorType,
        actorId: input.authorId,
        target: directMessageTarget(input.directMessageId),
        entityType: "message",
        entityId: id,
        payload: {},
      });
      const message = this.requireMessage(input.directMessageId, id);
      input.withinTransaction?.(conn, message);
      return message;
    })();
  }

  /**
   * 统计读游标之后的未读消息数（Human 未读投影）。
   * 排除 Human 自己发出的消息，避免「正在看的会话里自己发一条就冒角标」。
   */
  countMessagesAfterSeq(directMessageId: string, afterSeq: number): number {
    const row = this.getConn().prepare(`
      SELECT COUNT(*) AS count FROM direct_messages
      WHERE direct_message_id = ? AND dm_seq > ?
        AND deleted_at_ms IS NULL
        AND author_type != 'human'
    `).get(directMessageId, afterSeq) as { count: number };
    return Number(row.count) || 0;
  }

  listMessages(input: {
    directMessageId: string;
    beforeSeq?: number | null;
    afterSeq?: number | null;
    aroundMessageId?: string | null;
    limit?: number;
    viewer?: { type: ParticipantType; id: string } | null;
  }): { messages: DirectMessage[]; nextBeforeSeq: number | null } {
    const limit = Math.max(1, Math.min(100, Math.floor(input.limit ?? 50)));
    const viewer = input.viewer ?? null;
    if (input.aroundMessageId) {
      const pivot = this.getMessage(input.aroundMessageId);
      if (!pivot || pivot.directMessageId !== input.directMessageId) {
        throw new Error("around message not found");
      }
      const beforeLimit = Math.floor(limit / 2);
      const afterLimit = Math.max(1, limit - beforeLimit - 1);
      const before = this.listMessages({
        directMessageId: input.directMessageId,
        beforeSeq: pivot.dmSeq,
        limit: beforeLimit,
        viewer,
      }).messages.reverse();
      const after = this.listMessages({
        directMessageId: input.directMessageId,
        afterSeq: pivot.dmSeq,
        limit: afterLimit,
        viewer,
      }).messages;
      return {
        messages: [...before, this.projectMessage(pivot.id, viewer), ...after],
        nextBeforeSeq: before[0]?.dmSeq ?? null,
      };
    }
    if (input.afterSeq != null) {
      const rows = this.getConn().prepare(`
        SELECT * FROM direct_messages
        WHERE direct_message_id = ? AND dm_seq > ?
        ORDER BY dm_seq
        LIMIT ?
      `).all(input.directMessageId, input.afterSeq, limit) as MessageRow[];
      return {
        messages: rows.map((row) => this.projectMessage(row.id, viewer)),
        nextBeforeSeq: null,
      };
    }
    const beforeSeq = input.beforeSeq ?? Number.MAX_SAFE_INTEGER;
    const rows = this.getConn().prepare(`
      SELECT * FROM direct_messages
      WHERE direct_message_id = ? AND dm_seq < ?
      ORDER BY dm_seq DESC
      LIMIT ?
    `).all(input.directMessageId, beforeSeq, limit) as MessageRow[];
    return {
      messages: rows.map((row) => this.projectMessage(row.id, viewer)),
      nextBeforeSeq: rows.length === limit ? rows.at(-1)!.dm_seq : null,
    };
  }

  getMessage(id: string, viewer?: { type: ParticipantType; id: string } | null): DirectMessage | null {
    const row = this.getConn().prepare("SELECT * FROM direct_messages WHERE id = ?").get(id) as MessageRow | undefined;
    return row ? this.projectMessage(row.id, viewer ?? null) : null;
  }

  addReaction(input: {
    directMessageId: string;
    messageId: string;
    actorType: ParticipantType;
    actorId: string;
    emoji: string;
  }): DirectMessage {
    const emoji = input.emoji.trim();
    if (!emoji) throw new Error("emoji is required");
    const conn = this.getConn();
    return conn.transaction(() => {
      this.requireMessage(input.directMessageId, input.messageId);
      conn.prepare(`
        INSERT OR IGNORE INTO direct_message_reactions (message_id, actor_type, actor_id, emoji, created_at_ms)
        VALUES (?, ?, ?, ?, ?)
      `).run(input.messageId, input.actorType, input.actorId, emoji, nowMs());
      appendChatEvent(conn, {
        type: "reaction.added",
        actorType: input.actorType,
        actorId: input.actorId,
        target: directMessageTarget(input.directMessageId),
        entityType: "message",
        entityId: input.messageId,
      });
      return this.projectMessage(input.messageId, { type: input.actorType, id: input.actorId });
    })();
  }

  removeReaction(input: {
    directMessageId: string;
    messageId: string;
    actorType: ParticipantType;
    actorId: string;
    emoji: string;
  }): DirectMessage {
    const conn = this.getConn();
    return conn.transaction(() => {
      this.requireMessage(input.directMessageId, input.messageId);
      conn.prepare(`
        DELETE FROM direct_message_reactions
        WHERE message_id = ? AND actor_type = ? AND actor_id = ? AND emoji = ?
      `).run(input.messageId, input.actorType, input.actorId, input.emoji);
      appendChatEvent(conn, {
        type: "reaction.removed",
        actorType: input.actorType,
        actorId: input.actorId,
        target: directMessageTarget(input.directMessageId),
        entityType: "message",
        entityId: input.messageId,
      });
      return this.projectMessage(input.messageId, { type: input.actorType, id: input.actorId });
    })();
  }

  getMessageByImportKey(importKey: string): DirectMessage | null {
    const row = this.getConn().prepare(
      "SELECT * FROM direct_messages WHERE import_key = ?",
    ).get(importKey) as MessageRow | undefined;
    return row ? this.projectMessage(row.id, null) : null;
  }


  search(input: {
    directMessageIds: string[];
    query: string;
    limit?: number;
  }): DirectMessage[] {
    const q = input.query.trim();
    if (!q || input.directMessageIds.length === 0) return [];
    const limit = Math.max(1, Math.min(50, Math.floor(input.limit ?? 20)));
    const placeholders = input.directMessageIds.map(() => "?").join(", ");
    const rows = this.getConn().prepare(`
      SELECT * FROM direct_messages
      WHERE direct_message_id IN (${placeholders})
        AND deleted_at_ms IS NULL
        AND content LIKE ?
      ORDER BY created_at_ms DESC
      LIMIT ?
    `).all(...input.directMessageIds, `%${q}%`, limit) as MessageRow[];
    return rows.map((row) => this.projectMessage(row.id, null));
  }

  private ensureConversation(input: {
    left: { type: ParticipantType; id: string };
    right: { type: ParticipantType; id: string };
  }): DirectMessageConversation {
    if (!input.left.id.trim() || !input.right.id.trim()) throw new Error("participant id is required");
    const pair = normalizePair(input.left, input.right);
    const conn = this.getConn();
    return conn.transaction(() => {
      const existing = conn.prepare(`
        SELECT * FROM direct_message_conversations
        WHERE participant_a_type = ? AND participant_a_id = ?
          AND participant_b_type = ? AND participant_b_id = ?
      `).get(pair.aType, pair.aId, pair.bType, pair.bId) as ConversationRow | undefined;
      if (existing) return conversationFromRow(existing);
      const id = crypto.randomUUID();
      const createdAtMs = nowMs();
      conn.prepare(`
        INSERT INTO direct_message_conversations (
          id, participant_a_type, participant_a_id, participant_b_type, participant_b_id, created_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?)
      `).run(id, pair.aType, pair.aId, pair.bType, pair.bId, createdAtMs);
      appendChatEvent(conn, {
        type: "direct-message.created",
        actorType: "system",
        actorId: "tradex",
        target: directMessageTarget(id),
        entityType: "direct-message",
        entityId: id,
      });
      return this.getConversation(id)!;
    })();
  }


  private requireMessage(directMessageId: string, id: string): DirectMessage {
    const row = this.getConn().prepare(
      "SELECT * FROM direct_messages WHERE id = ? AND direct_message_id = ?",
    ).get(id, directMessageId) as MessageRow | undefined;
    if (!row) throw new Error(`Message not found: ${id}`);
    return this.projectMessage(row.id, null);
  }

  private projectMessage(
    messageId: string,
    viewer: { type: ParticipantType; id: string } | null,
  ): DirectMessage {
    const row = this.getConn().prepare("SELECT * FROM direct_messages WHERE id = ?").get(messageId) as MessageRow | undefined;
    if (!row) throw new Error(`Message not found: ${messageId}`);
    const reactions = this.getConn().prepare(`
      SELECT emoji,
             COUNT(*) AS count,
             SUM(CASE WHEN actor_type = ? AND actor_id = ? THEN 1 ELSE 0 END) AS reacted
      FROM direct_message_reactions WHERE message_id = ? GROUP BY emoji ORDER BY emoji
    `).all(
      viewer?.type ?? "",
      viewer?.id ?? "",
      messageId,
    ) as Array<{ emoji: string; count: number; reacted: number }>;
    return messageFromRow(row, reactions.map((reaction) => ({
      emoji: reaction.emoji,
      count: reaction.count,
      reacted: Boolean(reaction.reacted),
    })));
  }
}

function normalizePair(
  left: { type: ParticipantType; id: string },
  right: { type: ParticipantType; id: string },
): NormalizedPair {
  const leftKey = `${left.type}:${left.id}`;
  const rightKey = `${right.type}:${right.id}`;
  if (leftKey === rightKey) throw new Error("DM participants must be distinct");
  if (leftKey < rightKey) {
    return { aType: left.type, aId: left.id, bType: right.type, bId: right.id };
  }
  return { aType: right.type, aId: right.id, bType: left.type, bId: left.id };
}

function conversationFromRow(row: ConversationRow): DirectMessageConversation {
  return {
    id: row.id,
    participantAType: row.participant_a_type,
    participantAId: row.participant_a_id,
    participantBType: row.participant_b_type,
    participantBId: row.participant_b_id,
    createdAtMs: row.created_at_ms,
  };
}

function messageFromRow(
  row: MessageRow,
  reactions: DirectMessage["reactions"] = [],
): DirectMessage {
  return {
    id: row.id,
    directMessageId: row.direct_message_id,
    dmSeq: row.dm_seq,
    authorType: row.author_type,
    authorId: row.author_id,
    kind: row.kind,
    content: row.content,
    createdAtMs: row.created_at_ms,
    editedAtMs: row.edited_at_ms,
    deletedAtMs: row.deleted_at_ms,
    importKey: row.import_key,
    reactions,
  };
}


function migrateChatEventTargetKinds(conn: Database.Database): void {
  const schema = conn.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'chat_events'")
    .get() as { sql: string } | undefined;
  if (!schema?.sql.includes("'direct-chat'")) return;
  // 放宽 CHECK 以便遗留行仍可读；新写入使用 direct-message。
  conn.exec(`
    CREATE TABLE IF NOT EXISTS chat_events_next (
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
  const hasNext = conn.prepare("SELECT COUNT(*) AS c FROM chat_events_next").get() as { c: number };
  if (hasNext.c === 0) {
    conn.exec(`
      INSERT INTO chat_events_next (
        seq, type, actor_type, actor_id, target_kind, target_ref,
        entity_type, entity_id, payload_json, created_at_ms
      )
      SELECT seq, type, actor_type, actor_id, target_kind, target_ref,
        entity_type, entity_id, payload_json, created_at_ms
      FROM chat_events;
      DROP TABLE chat_events;
      ALTER TABLE chat_events_next RENAME TO chat_events;
    `);
  }
}
