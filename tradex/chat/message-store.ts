import Database from "better-sqlite3";
import crypto from "node:crypto";
import path from "node:path";
import { BaseStore, defaultCacheDir, nowMs } from "../db.js";
import { appendChatEvent, initChatEventSchema } from "../chat-events.js";
import { directMessageTarget } from "../channel/domain.js";

export const HUMAN_OWNER_ID = "owner";

export type ParticipantType = "human" | "agent";

export interface DirectMessageConversation {
  id: string;
  participantAType: ParticipantType;
  participantAId: string;
  participantBType: ParticipantType;
  participantBId: string;
  createdAtMs: number;
}

export interface DirectMessage {
  id: string;
  directMessageId: string;
  dmSeq: number;
  authorType: "human" | "agent" | "system";
  authorId: string;
  kind: string;
  content: string;
  threadRootId: string | null;
  createdAtMs: number;
  editedAtMs: number | null;
  deletedAtMs: number | null;
  importKey: string | null;
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
  thread_root_id: string | null;
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

export class MessageStore extends BaseStore {
  constructor(dbPath = path.join(defaultCacheDir(), "chat.sqlite3")) {
    super(dbPath);
  }

  protected override initSchema(conn: Database.Database): void {
    initChatEventSchema(conn);
    migrateChatEventTargetKinds(conn);
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
        thread_root_id TEXT REFERENCES direct_messages(id),
        created_at_ms INTEGER NOT NULL,
        edited_at_ms INTEGER,
        deleted_at_ms INTEGER,
        import_key TEXT,
        UNIQUE (direct_message_id, dm_seq),
        UNIQUE (import_key)
      );
      CREATE INDEX IF NOT EXISTS idx_direct_messages_timeline
        ON direct_messages (direct_message_id, dm_seq DESC);
    `);
  }

  ensureHumanAgentDm(agentId: string): DirectMessageConversation {
    return this.ensureConversation({
      left: { type: "human", id: HUMAN_OWNER_ID },
      right: { type: "agent", id: agentId },
    });
  }

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

  /** All DM conversations that include this Agent (Human-Agent and Agent-Agent). */
  listConversationsForAgent(agentId: string): DirectMessageConversation[] {
    const rows = this.getConn().prepare(`
      SELECT * FROM direct_message_conversations
      WHERE (participant_a_type = 'agent' AND participant_a_id = ?)
         OR (participant_b_type = 'agent' AND participant_b_id = ?)
      ORDER BY created_at_ms
    `).all(agentId, agentId) as ConversationRow[];
    return rows.map(conversationFromRow);
  }

  /** Resolve Human UI agentId navigation to the unique Human-Agent DM. */
  requireHumanAgentDm(agentId: string): DirectMessageConversation {
    return this.ensureHumanAgentDm(agentId);
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

  appendMessage(input: {
    directMessageId: string;
    authorType: DirectMessage["authorType"];
    authorId: string;
    content: string;
    threadRootId?: string | null;
    kind?: string;
    createdAtMs?: number;
    importKey?: string | null;
    onCommitted?: (conn: Database.Database, message: DirectMessage) => void;
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
        if (existing) return messageFromRow(existing);
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
          thread_root_id, created_at_ms, edited_at_ms, deleted_at_ms, import_key
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?)
      `).run(
        id,
        input.directMessageId,
        next.dm_seq,
        input.authorType,
        input.authorId,
        input.kind?.trim() || "message",
        content,
        this.validateThreadRoot(input.directMessageId, input.threadRootId),
        createdAtMs,
        input.importKey ?? null,
      );
      appendChatEvent(conn, {
        type: input.threadRootId ? "thread.reply-created" : "message.created",
        actorType: input.authorType === "system" ? "system" : input.authorType,
        actorId: input.authorId,
        target: directMessageTarget(input.directMessageId),
        entityType: "message",
        entityId: id,
        payload: input.threadRootId ? { threadRootId: input.threadRootId } : {},
      });
      const message = this.requireMessage(input.directMessageId, id);
      input.onCommitted?.(conn, message);
      return message;
    })();
  }

  listMessages(input: {
    directMessageId: string;
    beforeSeq?: number | null;
    afterSeq?: number | null;
    limit?: number;
  }): { messages: DirectMessage[]; nextBeforeSeq: number | null } {
    const limit = Math.max(1, Math.min(100, Math.floor(input.limit ?? 50)));
    if (input.afterSeq != null) {
      const rows = this.getConn().prepare(`
        SELECT * FROM direct_messages
        WHERE direct_message_id = ? AND thread_root_id IS NULL AND dm_seq > ?
        ORDER BY dm_seq
        LIMIT ?
      `).all(input.directMessageId, input.afterSeq, limit) as MessageRow[];
      return {
        messages: rows.map(messageFromRow),
        nextBeforeSeq: null,
      };
    }
    const beforeSeq = input.beforeSeq ?? Number.MAX_SAFE_INTEGER;
    const rows = this.getConn().prepare(`
      SELECT * FROM direct_messages
      WHERE direct_message_id = ? AND thread_root_id IS NULL AND dm_seq < ?
      ORDER BY dm_seq DESC
      LIMIT ?
    `).all(input.directMessageId, beforeSeq, limit) as MessageRow[];
    return {
      messages: rows.map(messageFromRow),
      nextBeforeSeq: rows.length === limit ? rows.at(-1)!.dm_seq : null,
    };
  }

  getMessage(id: string): DirectMessage | null {
    const row = this.getConn().prepare("SELECT * FROM direct_messages WHERE id = ?").get(id) as MessageRow | undefined;
    return row ? messageFromRow(row) : null;
  }

  getMessageByImportKey(importKey: string): DirectMessage | null {
    const row = this.getConn().prepare(
      "SELECT * FROM direct_messages WHERE import_key = ?",
    ).get(importKey) as MessageRow | undefined;
    return row ? messageFromRow(row) : null;
  }

  listThread(input: { directMessageId: string; rootMessageId: string }): {
    root: DirectMessage;
    replies: DirectMessage[];
  } {
    const root = this.requireMessage(input.directMessageId, input.rootMessageId);
    if (root.threadRootId) throw new Error("Thread root must be a top-level message");
    const rows = this.getConn().prepare(`
      SELECT * FROM direct_messages
      WHERE direct_message_id = ? AND thread_root_id = ?
      ORDER BY dm_seq
    `).all(input.directMessageId, input.rootMessageId) as MessageRow[];
    return { root, replies: rows.map(messageFromRow) };
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
    return rows.map(messageFromRow);
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

  private validateThreadRoot(directMessageId: string, threadRootId: string | null | undefined): string | null {
    if (!threadRootId) return null;
    const root = this.requireMessage(directMessageId, threadRootId);
    if (root.threadRootId) throw new Error("Thread root must be a top-level message");
    return root.id;
  }

  private requireMessage(directMessageId: string, id: string): DirectMessage {
    const row = this.getConn().prepare(
      "SELECT * FROM direct_messages WHERE id = ? AND direct_message_id = ?",
    ).get(id, directMessageId) as MessageRow | undefined;
    if (!row) throw new Error(`Message not found: ${id}`);
    return messageFromRow(row);
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

function messageFromRow(row: MessageRow): DirectMessage {
  return {
    id: row.id,
    directMessageId: row.direct_message_id,
    dmSeq: row.dm_seq,
    authorType: row.author_type,
    authorId: row.author_id,
    kind: row.kind,
    content: row.content,
    threadRootId: row.thread_root_id,
    createdAtMs: row.created_at_ms,
    editedAtMs: row.edited_at_ms,
    deletedAtMs: row.deleted_at_ms,
    importKey: row.import_key,
  };
}

function migrateChatEventTargetKinds(conn: Database.Database): void {
  const schema = conn.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'chat_events'")
    .get() as { sql: string } | undefined;
  if (!schema?.sql.includes("'direct-chat'")) return;
  // Widen CHECK so legacy rows remain readable; new writes use direct-message.
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
