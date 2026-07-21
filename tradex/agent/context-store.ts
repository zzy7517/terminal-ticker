/**
 * AgentContextStore — 逻辑 Agent Context 与当前 Runtime Session 绑定的持久化。
 *
 * 以 agentId 为主键。物理 Runtime Session 轮换只覆盖当前绑定，
 * 不保留 generations 历史，也不创建用户可见的新 DM。
 */
import Database from "better-sqlite3";
import crypto from "node:crypto";
import path from "node:path";
import { BaseStore, defaultCacheDir } from "../db.js";
import { initChatEventSchema } from "../chat/events.js";
import type { AgentRuntimeId } from "./runtime/types.js";

/** 逻辑 Agent Context 一行（以 agentId 为主键）。 */
export interface AgentContextRecord {
  agentId: string;
  /** Agent 的稳定逻辑 session id；不是用户可见 chatId。 */
  logicalSessionId: string;
  status: "idle" | "active" | "error" | "paused" | "offline";
  paused: boolean;
  workspacePath: string | null;
  memoryScope: string | null;
  lastActivationAtMs: number | null;
  lastError: string | null;
  activeSessionId: string | null;
  activeRuntime: AgentRuntimeId | null;
  nativeSessionId: string | null;
}

/** 当前物理 Runtime Session 绑定。 */
export interface AgentSessionBinding {
  agentId: string;
  sessionId: string;
  runtime: AgentRuntimeId;
  nativeSessionId: string | null;
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
  status: AgentContextRecord["status"];
  paused: number;
  workspace_path: string | null;
  memory_scope: string | null;
  last_activation_at_ms: number | null;
  last_error: string | null;
  active_session_id: string | null;
  active_runtime: AgentRuntimeId | null;
  native_session_id: string | null;
}

/** Agent Context / 当前 Session 绑定的 SQLite 持久化。 */
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
        status TEXT NOT NULL DEFAULT 'idle'
          CHECK (status IN ('idle', 'active', 'error', 'paused', 'offline')),
        paused INTEGER NOT NULL DEFAULT 0,
        workspace_path TEXT,
        memory_scope TEXT,
        last_activation_at_ms INTEGER,
        last_error TEXT,
        active_session_id TEXT,
        active_runtime TEXT CHECK (
          active_runtime IS NULL OR active_runtime IN ('pi', 'claude-code', 'cursor')
        ),
        native_session_id TEXT
      );
    `);
    // 必须先补列：旧库 CREATE TABLE IF NOT EXISTS 是 no-op，索引依赖新列。
    this.migrateBindingColumns(conn);
    this.migrateFromSessionHistory(conn);
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
          agent_id, logical_session_id, status, paused,
          workspace_path, memory_scope, last_activation_at_ms, last_error,
          active_session_id, active_runtime, native_session_id
        ) VALUES (?, ?, 'idle', 0, NULL, NULL, NULL, NULL, NULL, NULL, NULL)
      `).run(agentId, logicalSessionId);
      return this.require(agentId);
    })();
  }

  get(agentId: string): AgentContextRecord | null {
    const row = this.getConn().prepare(
      "SELECT * FROM agent_contexts WHERE agent_id = ?",
    ).get(agentId) as ContextRow | undefined;
    if (!row) return null;
    return contextFromRow(row);
  }

  /** 覆盖写入当前物理 Session 绑定；同 sessionId 幂等。 */
  attachSession(agentId: string, input: {
    sessionId: string;
    runtime: AgentRuntimeId;
    nativeSessionId?: string | null;
  }): AgentSessionBinding {
    const conn = this.getConn();
    return conn.transaction(() => {
      this.ensure(agentId);
      const owner = conn.prepare(
        "SELECT agent_id FROM agent_contexts WHERE active_session_id = ?",
      ).get(input.sessionId) as { agent_id: string } | undefined;
      if (owner && owner.agent_id !== agentId) {
        throw new Error("Session belongs to another Agent");
      }
      const current = this.require(agentId);
      if (current.activeSessionId === input.sessionId) {
        return {
          agentId,
          sessionId: input.sessionId,
          runtime: current.activeRuntime ?? input.runtime,
          nativeSessionId: current.nativeSessionId,
        };
      }
      conn.prepare(`
        UPDATE agent_contexts
        SET active_session_id = ?, active_runtime = ?, native_session_id = ?
        WHERE agent_id = ?
      `).run(
        input.sessionId,
        input.runtime,
        input.nativeSessionId ?? null,
        agentId,
      );
      return {
        agentId,
        sessionId: input.sessionId,
        runtime: input.runtime,
        nativeSessionId: input.nativeSessionId ?? null,
      };
    })();
  }

  contextForSession(sessionId: string): AgentContextRecord | null {
    const row = this.getConn().prepare(`
      SELECT * FROM agent_contexts WHERE active_session_id = ?
    `).get(sessionId) as ContextRow | undefined;
    if (!row) return null;
    return contextFromRow(row);
  }

  /** 若 sessionId 是当前绑定则清空；否则 no-op。 */
  removeSession(sessionId: string): void {
    this.getConn().prepare(`
      UPDATE agent_contexts
      SET active_session_id = NULL, active_runtime = NULL, native_session_id = NULL
      WHERE active_session_id = ?
    `).run(sessionId);
  }

  hasSessionsForAgent(agentId: string): boolean {
    return Boolean(this.getConn().prepare(`
      SELECT 1 FROM agent_contexts
      WHERE agent_id = ? AND active_session_id IS NOT NULL
      LIMIT 1
    `).get(agentId));
  }

  /** 每个 Agent 只绑最新一条；已有当前绑定则跳过。 */
  indexSessions(sessions: ExistingAgentSession[]): void {
    const conn = this.getConn();
    conn.transaction(() => {
      const newestByAgent = new Map<string, ExistingAgentSession>();
      for (const session of sessions) {
        const current = newestByAgent.get(session.agentId);
        if (!current || session.createdAtMs >= current.createdAtMs) {
          newestByAgent.set(session.agentId, session);
        }
      }
      for (const [agentId, session] of newestByAgent) {
        const context = this.ensure(agentId);
        if (context.activeSessionId) continue;
        this.attachSession(agentId, {
          sessionId: session.sessionId,
          runtime: session.runtime,
        });
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

  private require(agentId: string): AgentContextRecord {
    const context = this.get(agentId);
    if (!context) throw new Error(`Agent Context not found: ${agentId}`);
    return context;
  }

  /** 为已有 agent_contexts 表补当前绑定列。 */
  private migrateBindingColumns(conn: Database.Database): void {
    const cols = conn.prepare("PRAGMA table_info(agent_contexts)").all() as Array<{ name: string }>;
    const names = new Set(cols.map((col) => col.name));
    if (!names.has("active_session_id")) {
      conn.exec("ALTER TABLE agent_contexts ADD COLUMN active_session_id TEXT");
    }
    if (!names.has("active_runtime")) {
      conn.exec("ALTER TABLE agent_contexts ADD COLUMN active_runtime TEXT");
    }
    if (!names.has("native_session_id")) {
      conn.exec("ALTER TABLE agent_contexts ADD COLUMN native_session_id TEXT");
    }
    conn.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_contexts_active_session
        ON agent_contexts (active_session_id)
        WHERE active_session_id IS NOT NULL
    `);
  }

  /** 从旧 generations 表迁出每个 Agent 的最新绑定后 DROP。 */
  private migrateFromSessionHistory(conn: Database.Database): void {
    const hasHistory = conn.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'agent_context_sessions'",
    ).get() as { name: string } | undefined;
    if (!hasHistory) return;

    const latest = conn.prepare(`
      SELECT s.agent_id, s.session_id, s.runtime, s.native_session_id
      FROM agent_context_sessions s
      INNER JOIN (
        SELECT agent_id, MAX(generation) AS generation
        FROM agent_context_sessions
        GROUP BY agent_id
      ) latest
        ON latest.agent_id = s.agent_id AND latest.generation = s.generation
    `).all() as Array<{
      agent_id: string;
      session_id: string;
      runtime: AgentRuntimeId;
      native_session_id: string | null;
    }>;

    for (const row of latest) {
      conn.prepare(`
        UPDATE agent_contexts
        SET active_session_id = ?, active_runtime = ?, native_session_id = ?
        WHERE agent_id = ? AND active_session_id IS NULL
      `).run(row.session_id, row.runtime, row.native_session_id, row.agent_id);
    }
    conn.exec("DROP TABLE agent_context_sessions");
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
          agent_id, logical_session_id, status, paused,
          workspace_path, memory_scope, last_activation_at_ms, last_error,
          active_session_id, active_runtime, native_session_id
        ) VALUES (?, ?, 'idle', 0, NULL, NULL, NULL, NULL, NULL, NULL, NULL)
      `).run(agentId, logicalSessionId);

      let latest: {
        session_id: string;
        runtime: AgentRuntimeId;
        created_at_ms: number;
      } | null = null;
      for (const chat of agentChats) {
        const sessions = conn.prepare(`
          SELECT session_id, runtime, created_at_ms
          FROM agent_chat_sessions WHERE chat_id = ? ORDER BY generation
        `).all(chat.id) as Array<{
          session_id: string;
          runtime: AgentRuntimeId;
          created_at_ms: number;
        }>;
        for (const session of sessions) {
          if (!latest || session.created_at_ms >= latest.created_at_ms) {
            latest = session;
          }
        }
      }
      if (latest) {
        conn.prepare(`
          UPDATE agent_contexts
          SET active_session_id = ?, active_runtime = ?, native_session_id = NULL
          WHERE agent_id = ?
        `).run(latest.session_id, latest.runtime, agentId);
      }
    }
  }
}

function contextFromRow(row: ContextRow): AgentContextRecord {
  return {
    agentId: row.agent_id,
    logicalSessionId: row.logical_session_id,
    status: row.status,
    paused: Boolean(row.paused),
    workspacePath: row.workspace_path,
    memoryScope: row.memory_scope,
    lastActivationAtMs: row.last_activation_at_ms,
    lastError: row.last_error,
    activeSessionId: row.active_session_id,
    activeRuntime: row.active_runtime,
    nativeSessionId: row.native_session_id,
  };
}
