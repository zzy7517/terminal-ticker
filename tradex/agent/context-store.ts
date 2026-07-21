/**
 * AgentContextStore — 逻辑 Agent Context 与 Runtime generation 的持久化。
 *
 * 以 agentId 为主键。物理 Runtime Session 轮换会递增 generation，
 * 但不会创建用户可见的新 DM 或 chatId。存在遗留 agent_chats 行时会迁移。
 */
import Database from "better-sqlite3";
import crypto from "node:crypto";
import path from "node:path";
import { BaseStore, defaultCacheDir, nowMs } from "../db.js";
import { initChatEventSchema } from "../chat/events.js";
import type { AgentRuntimeId } from "./runtime/types.js";

/** 逻辑 Agent Context 一行（以 agentId 为主键）。 */
export interface AgentContextRecord {
  agentId: string;
  /** Agent 的稳定逻辑 session id；不是用户可见 chatId。 */
  logicalSessionId: string;
  activeRuntimeGeneration: number;
  snapshotGeneration: number;
  status: "idle" | "active" | "error" | "paused" | "offline";
  paused: boolean;
  workspacePath: string | null;
  memoryScope: string | null;
  lastActivationAtMs: number | null;
  lastError: string | null;
  activeSessionId: string | null;
}

/** 一次物理 Runtime Session generation 记录。 */
export interface AgentContextSession {
  agentId: string;
  generation: number;
  sessionId: string;
  runtime: AgentRuntimeId;
  nativeSessionId: string | null;
  startedAtMs: number;
  endedAtMs: number | null;
  rotationReason: string;
}

/** 遗留 Session 行，用于导入/绑定到 Agent Context。 */
export interface ExistingAgentSession {
  sessionId: string;
  agentId: string;
  title: string;
  runtime: AgentRuntimeId;
  createdAtMs: number;
  updatedAtMs: number;
}

interface ContextRow {
  agent_id: string;
  logical_session_id: string;
  active_runtime_generation: number;
  snapshot_generation: number;
  status: AgentContextRecord["status"];
  paused: number;
  workspace_path: string | null;
  memory_scope: string | null;
  last_activation_at_ms: number | null;
  last_error: string | null;
}

interface SessionRow {
  agent_id: string;
  generation: number;
  session_id: string;
  runtime: AgentRuntimeId;
  native_session_id: string | null;
  started_at_ms: number;
  ended_at_ms: number | null;
  rotation_reason: string;
}

/** Agent Context / generation 的 SQLite 持久化。 */
export class AgentContextStore extends BaseStore {
  constructor(dbPath = path.join(defaultCacheDir(), "chat.sqlite3")) {
    super(dbPath);
  }

  protected override initSchema(conn: Database.Database): void {
    initChatEventSchema(conn);
    conn.exec(`
      CREATE TABLE IF NOT EXISTS agent_contexts (
        agent_id TEXT PRIMARY KEY,
        logical_session_id TEXT NOT NULL,
        active_runtime_generation INTEGER NOT NULL DEFAULT 0,
        snapshot_generation INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'idle'
          CHECK (status IN ('idle', 'active', 'error', 'paused', 'offline')),
        paused INTEGER NOT NULL DEFAULT 0,
        workspace_path TEXT,
        memory_scope TEXT,
        last_activation_at_ms INTEGER,
        last_error TEXT
      );
      CREATE TABLE IF NOT EXISTS agent_context_sessions (
        agent_id TEXT NOT NULL REFERENCES agent_contexts(agent_id) ON DELETE CASCADE,
        generation INTEGER NOT NULL,
        session_id TEXT NOT NULL UNIQUE,
        runtime TEXT NOT NULL CHECK (runtime IN ('pi', 'claude-code', 'cursor')),
        native_session_id TEXT,
        started_at_ms INTEGER NOT NULL,
        ended_at_ms INTEGER,
        rotation_reason TEXT NOT NULL DEFAULT 'initial',
        PRIMARY KEY (agent_id, generation)
      );
      CREATE INDEX IF NOT EXISTS idx_agent_context_sessions_session
        ON agent_context_sessions (session_id);
    `);
    this.migrateRuntimeConstraint(conn);
    this.migrateLegacyChats(conn);
  }

  ensure(agentId: string): AgentContextRecord {
    if (!agentId.trim()) throw new Error("agentId is required");
    const conn = this.getConn();
    return conn.transaction(() => {
      const existing = this.get(agentId);
      if (existing) return existing;
      const logicalSessionId = crypto.randomUUID();
      conn.prepare(`
        INSERT INTO agent_contexts (
          agent_id, logical_session_id, active_runtime_generation, snapshot_generation,
          status, paused, workspace_path, memory_scope, last_activation_at_ms, last_error
        ) VALUES (?, ?, 0, 0, 'idle', 0, NULL, NULL, NULL, NULL)
      `).run(agentId, logicalSessionId);
      return this.require(agentId);
    })();
  }

  get(agentId: string): AgentContextRecord | null {
    const row = this.getConn().prepare(
      "SELECT * FROM agent_contexts WHERE agent_id = ?",
    ).get(agentId) as ContextRow | undefined;
    if (!row) return null;
    return contextFromRow(row, this.activeSessionId(agentId));
  }

  attachSession(agentId: string, input: {
    sessionId: string;
    runtime: AgentRuntimeId;
    nativeSessionId?: string | null;
    startedAtMs?: number;
    rotationReason?: string;
  }): AgentContextSession {
    const conn = this.getConn();
    return conn.transaction(() => {
      this.ensure(agentId);
      const existing = conn.prepare(
        "SELECT * FROM agent_context_sessions WHERE session_id = ?",
      ).get(input.sessionId) as SessionRow | undefined;
      if (existing) {
        if (existing.agent_id !== agentId) throw new Error("Session belongs to another Agent");
        return sessionFromRow(existing);
      }
      const current = this.require(agentId);
      if (current.activeSessionId) {
        conn.prepare(`
          UPDATE agent_context_sessions SET ended_at_ms = ?
          WHERE agent_id = ? AND generation = ? AND ended_at_ms IS NULL
        `).run(nowMs(), agentId, current.activeRuntimeGeneration);
      }
      const generation = current.activeRuntimeGeneration + 1;
      const startedAtMs = input.startedAtMs ?? nowMs();
      conn.prepare(`
        INSERT INTO agent_context_sessions (
          agent_id, generation, session_id, runtime, native_session_id,
          started_at_ms, ended_at_ms, rotation_reason
        ) VALUES (?, ?, ?, ?, ?, ?, NULL, ?)
      `).run(
        agentId,
        generation,
        input.sessionId,
        input.runtime,
        input.nativeSessionId ?? null,
        startedAtMs,
        input.rotationReason ?? "initial",
      );
      conn.prepare(`
        UPDATE agent_contexts SET active_runtime_generation = ? WHERE agent_id = ?
      `).run(generation, agentId);
      return this.listSessions(agentId).at(-1)!;
    })();
  }

  listSessions(agentId: string): AgentContextSession[] {
    const rows = this.getConn().prepare(`
      SELECT * FROM agent_context_sessions WHERE agent_id = ? ORDER BY generation
    `).all(agentId) as SessionRow[];
    return rows.map(sessionFromRow);
  }

  contextForSession(sessionId: string): AgentContextRecord | null {
    const row = this.getConn().prepare(`
      SELECT c.* FROM agent_contexts c
      JOIN agent_context_sessions s ON s.agent_id = c.agent_id
      WHERE s.session_id = ?
    `).get(sessionId) as ContextRow | undefined;
    if (!row) return null;
    return contextFromRow(row, this.activeSessionId(row.agent_id));
  }

  removeSession(sessionId: string): void {
    const conn = this.getConn();
    conn.transaction(() => {
      const session = conn.prepare(
        "SELECT * FROM agent_context_sessions WHERE session_id = ?",
      ).get(sessionId) as SessionRow | undefined;
      if (!session) return;
      conn.prepare("DELETE FROM agent_context_sessions WHERE session_id = ?").run(sessionId);
      const latest = conn.prepare(`
        SELECT COALESCE(MAX(generation), 0) AS generation
        FROM agent_context_sessions WHERE agent_id = ?
      `).get(session.agent_id) as { generation: number };
      conn.prepare(`
        UPDATE agent_contexts SET active_runtime_generation = ? WHERE agent_id = ?
      `).run(latest.generation, session.agent_id);
      if (latest.generation > 0) {
        conn.prepare(`
          UPDATE agent_context_sessions SET ended_at_ms = NULL
          WHERE agent_id = ? AND generation = ?
        `).run(session.agent_id, latest.generation);
      }
    })();
  }

  hasSessionsForAgent(agentId: string): boolean {
    return Boolean(this.getConn().prepare(`
      SELECT 1 FROM agent_context_sessions WHERE agent_id = ? LIMIT 1
    `).get(agentId));
  }

  indexSessions(sessions: ExistingAgentSession[]): void {
    const conn = this.getConn();
    conn.transaction(() => {
      const byAgent = new Map<string, ExistingAgentSession[]>();
      for (const session of sessions) {
        if (conn.prepare("SELECT 1 FROM agent_context_sessions WHERE session_id = ?").get(session.sessionId)) {
          continue;
        }
        const existing = byAgent.get(session.agentId) ?? [];
        existing.push(session);
        byAgent.set(session.agentId, existing);
      }
      for (const [agentId, pending] of byAgent) {
        this.ensure(agentId);
        for (const session of pending.sort((left, right) => left.createdAtMs - right.createdAtMs)) {
          this.attachSession(agentId, {
            sessionId: session.sessionId,
            runtime: session.runtime,
            startedAtMs: session.createdAtMs,
            rotationReason: "imported",
          });
        }
      }
    })();
  }

  updateStatus(agentId: string, input: {
    status?: AgentContextRecord["status"];
    paused?: boolean;
    lastError?: string | null;
    lastActivationAtMs?: number | null;
    workspacePath?: string | null;
    memoryScope?: string | null;
  }): AgentContextRecord {
    const conn = this.getConn();
    return conn.transaction(() => {
      const current = this.ensure(agentId);
      conn.prepare(`
        UPDATE agent_contexts SET
          status = ?,
          paused = ?,
          last_error = ?,
          last_activation_at_ms = ?,
          workspace_path = ?,
          memory_scope = ?
        WHERE agent_id = ?
      `).run(
        input.status ?? current.status,
        Number(input.paused ?? current.paused),
        input.lastError === undefined ? current.lastError : input.lastError,
        input.lastActivationAtMs === undefined ? current.lastActivationAtMs : input.lastActivationAtMs,
        input.workspacePath === undefined ? current.workspacePath : input.workspacePath,
        input.memoryScope === undefined ? current.memoryScope : input.memoryScope,
        agentId,
      );
      return this.require(agentId);
    })();
  }

  private activeSessionId(agentId: string): string | null {
    const row = this.getConn().prepare(`
      SELECT session_id FROM agent_context_sessions
      WHERE agent_id = ?
      ORDER BY generation DESC LIMIT 1
    `).get(agentId) as { session_id: string } | undefined;
    return row?.session_id ?? null;
  }

  private require(agentId: string): AgentContextRecord {
    const context = this.get(agentId);
    if (!context) throw new Error(`Agent Context not found: ${agentId}`);
    return context;
  }

  private migrateRuntimeConstraint(conn: Database.Database): void {
    const row = conn.prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'agent_context_sessions'",
    ).get() as { sql: string } | undefined;
    if (!row?.sql || row.sql.includes("'cursor'")) return;
    conn.transaction(() => {
      conn.exec(`
        CREATE TABLE agent_context_sessions_v2 (
        agent_id TEXT NOT NULL REFERENCES agent_contexts(agent_id) ON DELETE CASCADE,
        generation INTEGER NOT NULL,
        session_id TEXT NOT NULL UNIQUE,
        runtime TEXT NOT NULL CHECK (runtime IN ('pi', 'claude-code', 'cursor')),
        native_session_id TEXT,
        started_at_ms INTEGER NOT NULL,
        ended_at_ms INTEGER,
        rotation_reason TEXT NOT NULL DEFAULT 'initial',
        PRIMARY KEY (agent_id, generation)
      );
      INSERT INTO agent_context_sessions_v2
        SELECT agent_id, generation, session_id, runtime, native_session_id,
               started_at_ms, ended_at_ms, rotation_reason
        FROM agent_context_sessions;
      DROP TABLE agent_context_sessions;
      ALTER TABLE agent_context_sessions_v2 RENAME TO agent_context_sessions;
        CREATE INDEX IF NOT EXISTS idx_agent_context_sessions_session
          ON agent_context_sessions (session_id);
      `);
    })();
  }

  private migrateLegacyChats(conn: Database.Database): void {
    const hasLegacy = conn.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'agent_chats'",
    ).get() as { name: string } | undefined;
    if (!hasLegacy) return;
    const already = conn.prepare("SELECT COUNT(*) AS c FROM agent_contexts").get() as { c: number };
    if (already.c > 0) return;

    const chats = conn.prepare(`
      SELECT id, agent_id, status, created_at_ms
      FROM agent_chats
      ORDER BY agent_id, ordinal
    `).all() as Array<{ id: string; agent_id: string; status: string; created_at_ms: number }>;
    const byAgent = new Map<string, typeof chats>();
    for (const chat of chats) {
      const list = byAgent.get(chat.agent_id) ?? [];
      list.push(chat);
      byAgent.set(chat.agent_id, list);
    }
    for (const [agentId, agentChats] of byAgent) {
      const logicalSessionId = crypto.randomUUID();
      conn.prepare(`
        INSERT OR IGNORE INTO agent_contexts (
          agent_id, logical_session_id, active_runtime_generation, snapshot_generation,
          status, paused, workspace_path, memory_scope, last_activation_at_ms, last_error
        ) VALUES (?, ?, 0, 0, 'idle', 0, NULL, NULL, NULL, NULL)
      `).run(agentId, logicalSessionId);
      let generation = 0;
      for (const chat of agentChats) {
        const sessions = conn.prepare(`
          SELECT session_id, runtime, created_at_ms, rotation_reason
          FROM agent_chat_sessions WHERE chat_id = ? ORDER BY generation
        `).all(chat.id) as Array<{
          session_id: string;
          runtime: AgentRuntimeId;
          created_at_ms: number;
          rotation_reason: string;
        }>;
        for (const session of sessions) {
          if (conn.prepare("SELECT 1 FROM agent_context_sessions WHERE session_id = ?").get(session.session_id)) {
            continue;
          }
          generation += 1;
          conn.prepare(`
            INSERT INTO agent_context_sessions (
              agent_id, generation, session_id, runtime, native_session_id,
              started_at_ms, ended_at_ms, rotation_reason
            ) VALUES (?, ?, ?, ?, NULL, ?, NULL, ?)
          `).run(
            agentId,
            generation,
            session.session_id,
            session.runtime,
            session.created_at_ms,
            session.rotation_reason || "imported",
          );
        }
      }
      conn.prepare(`
        UPDATE agent_contexts SET active_runtime_generation = ? WHERE agent_id = ?
      `).run(generation, agentId);
    }
  }
}

function contextFromRow(row: ContextRow, activeSessionId: string | null): AgentContextRecord {
  return {
    agentId: row.agent_id,
    logicalSessionId: row.logical_session_id,
    activeRuntimeGeneration: row.active_runtime_generation,
    snapshotGeneration: row.snapshot_generation,
    status: row.status,
    paused: Boolean(row.paused),
    workspacePath: row.workspace_path,
    memoryScope: row.memory_scope,
    lastActivationAtMs: row.last_activation_at_ms,
    lastError: row.last_error,
    activeSessionId,
  };
}

function sessionFromRow(row: SessionRow): AgentContextSession {
  return {
    agentId: row.agent_id,
    generation: row.generation,
    sessionId: row.session_id,
    runtime: row.runtime,
    nativeSessionId: row.native_session_id,
    startedAtMs: row.started_at_ms,
    endedAtMs: row.ended_at_ms,
    rotationReason: row.rotation_reason,
  };
}
