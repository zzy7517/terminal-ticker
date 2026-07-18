import Database from "better-sqlite3";
import crypto from "node:crypto";
import path from "node:path";
import { BaseStore, defaultCacheDir, nowMs } from "../db.js";
import { appendChatEvent, initChatEventSchema } from "../chat-events.js";
import { directChatTarget } from "../channel/domain.js";

export const DEFAULT_CHAT_FILENAME = "chat.sqlite3";

export interface AgentChat {
  id: string;
  agentId: string;
  ordinal: number;
  title: string;
  status: "active" | "archived";
  createdAtMs: number;
  archivedAtMs: number | null;
  activeSessionId: string | null;
  generationCount: number;
}

export interface AgentChatSession {
  chatId: string;
  generation: number;
  sessionId: string;
  runtime: "pi" | "claude-code";
  createdAtMs: number;
  rotationReason: string;
}

export interface ExistingAgentSession {
  sessionId: string;
  agentId: string;
  title: string;
  runtime: "pi" | "claude-code";
  createdAtMs: number;
  updatedAtMs: number;
}

interface AgentChatRow {
  id: string;
  agent_id: string;
  ordinal: number;
  title: string;
  status: "active" | "archived";
  created_at_ms: number;
  archived_at_ms: number | null;
  active_session_id: string | null;
  generation_count: number;
}

interface AgentChatSessionRow {
  chat_id: string;
  generation: number;
  session_id: string;
  runtime: "pi" | "claude-code";
  created_at_ms: number;
  rotation_reason: string;
}

const CHAT_SELECT = `
  SELECT c.*,
    (SELECT s.session_id FROM agent_chat_sessions s
      WHERE s.chat_id = c.id ORDER BY s.generation DESC LIMIT 1) AS active_session_id,
    (SELECT COUNT(*) FROM agent_chat_sessions s WHERE s.chat_id = c.id) AS generation_count
  FROM agent_chats c
`;

export class AgentChatStore extends BaseStore {
  constructor(dbPath = path.join(defaultCacheDir(), DEFAULT_CHAT_FILENAME)) {
    super(dbPath);
  }

  protected override initSchema(conn: Database.Database): void {
    initChatEventSchema(conn);
    conn.exec(`
      CREATE TABLE IF NOT EXISTS agent_chats (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        ordinal INTEGER NOT NULL,
        title TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('active', 'archived')),
        created_at_ms INTEGER NOT NULL,
        archived_at_ms INTEGER,
        UNIQUE (agent_id, ordinal)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_chats_one_active
        ON agent_chats (agent_id) WHERE status = 'active';
      CREATE INDEX IF NOT EXISTS idx_agent_chats_agent_created
        ON agent_chats (agent_id, created_at_ms DESC);
      CREATE TABLE IF NOT EXISTS agent_chat_sessions (
        chat_id TEXT NOT NULL REFERENCES agent_chats(id) ON DELETE CASCADE,
        generation INTEGER NOT NULL,
        session_id TEXT NOT NULL UNIQUE,
        runtime TEXT NOT NULL CHECK (runtime IN ('pi', 'claude-code')),
        created_at_ms INTEGER NOT NULL,
        rotation_reason TEXT NOT NULL DEFAULT 'initial',
        PRIMARY KEY (chat_id, generation)
      );
    `);
    ensureColumn(conn, "agent_chat_sessions", "rotation_reason", "TEXT NOT NULL DEFAULT 'initial'");
  }

  create(agentId: string, title = "New Chat"): AgentChat {
    if (!agentId.trim()) throw new Error("agentId is required");
    const conn = this.getConn();
    return conn.transaction(() => {
      const createdAtMs = nowMs();
      const previous = this.activeForAgent(agentId);
      if (previous) {
        conn.prepare(
          "UPDATE agent_chats SET status = 'archived', archived_at_ms = ? WHERE id = ?",
        ).run(createdAtMs, previous.id);
      }
      const row = conn.prepare(
        "SELECT COALESCE(MAX(ordinal), 0) + 1 AS ordinal FROM agent_chats WHERE agent_id = ?",
      ).get(agentId) as { ordinal: number };
      const id = crypto.randomUUID();
      conn.prepare(`
        INSERT INTO agent_chats (
          id, agent_id, ordinal, title, status, created_at_ms, archived_at_ms
        ) VALUES (?, ?, ?, ?, 'active', ?, NULL)
      `).run(id, agentId, row.ordinal, title.trim() || "New Chat", createdAtMs);
      appendChatEvent(conn, {
        type: "direct-chat.created",
        actorType: "human",
        actorId: "owner",
        target: directChatTarget(agentId, id),
        entityType: "direct-chat",
        entityId: id,
        payload: { ordinal: row.ordinal },
      });
      return this.require(id);
    })();
  }

  activeForAgent(agentId: string): AgentChat | null {
    const row = this.getConn().prepare(
      `${CHAT_SELECT} WHERE c.agent_id = ? AND c.status = 'active'`,
    ).get(agentId) as AgentChatRow | undefined;
    return row ? chatFromRow(row) : null;
  }

  get(id: string): AgentChat | null {
    const row = this.getConn().prepare(`${CHAT_SELECT} WHERE c.id = ?`).get(id) as AgentChatRow | undefined;
    return row ? chatFromRow(row) : null;
  }

  listForAgent(agentId: string): AgentChat[] {
    const rows = this.getConn().prepare(`
      ${CHAT_SELECT}
      WHERE c.agent_id = ?
      ORDER BY c.ordinal DESC
    `).all(agentId) as AgentChatRow[];
    return rows.map(chatFromRow);
  }

  hasSessionsForAgent(agentId: string): boolean {
    return Boolean(this.getConn().prepare(`
      SELECT 1
      FROM agent_chat_sessions s
      JOIN agent_chats c ON c.id = s.chat_id
      WHERE c.agent_id = ?
      LIMIT 1
    `).get(agentId));
  }

  deleteEmptyChatsForAgent(agentId: string): void {
    const conn = this.getConn();
    conn.prepare(`
      DELETE FROM agent_chats
      WHERE agent_id = ?
        AND NOT EXISTS (
          SELECT 1 FROM agent_chat_sessions s WHERE s.chat_id = agent_chats.id
        )
    `).run(agentId);
  }

  indexSessions(sessions: ExistingAgentSession[]): void {
    const conn = this.getConn();
    conn.transaction(() => {
      const byAgent = new Map<string, ExistingAgentSession[]>();
      for (const session of sessions) {
        if (conn.prepare("SELECT 1 FROM agent_chat_sessions WHERE session_id = ?").get(session.sessionId)) continue;
        const existing = byAgent.get(session.agentId) ?? [];
        existing.push(session);
        byAgent.set(session.agentId, existing);
      }

      for (const [agentId, pending] of byAgent) {
        const hadActiveChat = Boolean(this.activeForAgent(agentId));
        let ordinal = (conn.prepare(
          "SELECT COALESCE(MAX(ordinal), 0) AS ordinal FROM agent_chats WHERE agent_id = ?",
        ).get(agentId) as { ordinal: number }).ordinal;
        const inserted: Array<{ chatId: string; updatedAtMs: number }> = [];
        for (const session of pending.sort((left, right) => left.createdAtMs - right.createdAtMs)) {
          ordinal += 1;
          const chatId = crypto.randomUUID();
          conn.prepare(`
            INSERT INTO agent_chats (
              id, agent_id, ordinal, title, status, created_at_ms, archived_at_ms
            ) VALUES (?, ?, ?, ?, 'archived', ?, ?)
          `).run(chatId, agentId, ordinal, session.title.trim() || "Imported Chat", session.createdAtMs, session.updatedAtMs);
          conn.prepare(`
            INSERT INTO agent_chat_sessions (chat_id, generation, session_id, runtime, created_at_ms, rotation_reason)
            VALUES (?, 1, ?, ?, ?, 'imported')
          `).run(chatId, session.sessionId, session.runtime, session.createdAtMs);
          appendChatEvent(conn, {
            type: "direct-chat.imported",
            actorType: "system",
            actorId: "tradex",
            target: directChatTarget(agentId, chatId),
            entityType: "direct-chat",
            entityId: chatId,
            payload: { sessionId: session.sessionId, generation: 1 },
          });
          inserted.push({ chatId, updatedAtMs: session.updatedAtMs });
        }
        if (!hadActiveChat && inserted.length > 0) {
          const latest = inserted.sort((left, right) => right.updatedAtMs - left.updatedAtMs)[0];
          conn.prepare(
            "UPDATE agent_chats SET status = 'active', archived_at_ms = NULL WHERE id = ?",
          ).run(latest.chatId);
        }
      }
    })();
  }

  attachSession(chatId: string, input: {
    sessionId: string;
    runtime: "pi" | "claude-code";
    createdAtMs?: number;
    rotationReason?: string;
  }): AgentChatSession {
    const conn = this.getConn();
    return conn.transaction(() => {
      const chat = this.require(chatId);
      if (chat.status !== "active") throw new Error("cannot attach a Session to an archived Chat");
      const generation = (conn.prepare(
        "SELECT COALESCE(MAX(generation), 0) + 1 AS generation FROM agent_chat_sessions WHERE chat_id = ?",
      ).get(chatId) as { generation: number }).generation;
      conn.prepare(`
        INSERT INTO agent_chat_sessions (chat_id, generation, session_id, runtime, created_at_ms, rotation_reason)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(chatId, generation, input.sessionId, input.runtime, input.createdAtMs ?? nowMs(), input.rotationReason ?? "initial");
      appendChatEvent(conn, {
        type: "direct-chat.session-attached",
        actorType: "system",
        actorId: "tradex",
        target: directChatTarget(chat.agentId, chat.id),
        entityType: "session",
        entityId: input.sessionId,
      payload: { generation, runtime: input.runtime },
      });
      return this.listSessions(chatId).at(-1)!;
    })();
  }

  chatForSession(sessionId: string): AgentChat | null {
    const row = this.getConn().prepare(`
      ${CHAT_SELECT}
      JOIN agent_chat_sessions matched ON matched.chat_id = c.id
      WHERE matched.session_id = ?
    `).get(sessionId) as AgentChatRow | undefined;
    return row ? chatFromRow(row) : null;
  }

  removeSession(sessionId: string): void {
    const conn = this.getConn();
    conn.transaction(() => {
      const chat = this.chatForSession(sessionId);
      if (!chat) return;
      conn.prepare("DELETE FROM agent_chat_sessions WHERE session_id = ?").run(sessionId);
      appendChatEvent(conn, {
        type: "direct-chat.session-removed",
        actorType: "human",
        actorId: "owner",
        target: directChatTarget(chat.agentId, chat.id),
        entityType: "session",
        entityId: sessionId,
      });
    })();
  }

  listSessions(chatId: string): AgentChatSession[] {
    const rows = this.getConn().prepare(`
      SELECT * FROM agent_chat_sessions WHERE chat_id = ? ORDER BY generation
    `).all(chatId) as AgentChatSessionRow[];
    return rows.map(sessionFromRow);
  }

  private require(id: string): AgentChat {
    const chat = this.get(id);
    if (!chat) throw new Error(`Chat not found: ${id}`);
    return chat;
  }
}

function chatFromRow(row: AgentChatRow): AgentChat {
  return {
    id: row.id,
    agentId: row.agent_id,
    ordinal: row.ordinal,
    title: row.title,
    status: row.status,
    createdAtMs: row.created_at_ms,
    archivedAtMs: row.archived_at_ms,
    activeSessionId: row.active_session_id,
    generationCount: row.generation_count,
  };
}

function sessionFromRow(row: AgentChatSessionRow): AgentChatSession {
  return {
    chatId: row.chat_id,
    generation: row.generation,
    sessionId: row.session_id,
    runtime: row.runtime,
    createdAtMs: row.created_at_ms,
    rotationReason: row.rotation_reason,
  };
}

function ensureColumn(conn: Database.Database, table: string, column: string, definition: string): void {
  const columns = conn.pragma(`table_info(${table})`) as Array<{ name: string }>;
  if (!columns.some((entry) => entry.name === column)) {
    conn.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}
