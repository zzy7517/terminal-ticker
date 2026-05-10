import Database from "better-sqlite3";
import crypto from "node:crypto";
import path from "node:path";
import { BaseStore, defaultCacheDir, jsonDumps, jsonLoads } from "../db.js";

export const DEFAULT_AGENT_SESSION_FILENAME = "agent_sessions.sqlite3";
const GLOBAL_SESSION_INSTRUMENT_KEY = "";

export interface AgentSession {
  id: string;
  instrumentKey: string | null;
  title: string;
  provider: string;
  model: string;
  createdAt: string;
  updatedAt: string;
  active: boolean;
  apiMode: string | null;
  reasoningEffort: string | null;
}

export interface AgentMessage {
  id: number;
  sessionId: string;
  role: string;
  content: string;
  createdAt: string;
  metadata: Record<string, unknown> | null;
  context: Record<string, unknown> | null;
  error: string | null;
}

export interface AgentSessionSummary extends AgentSession {
  messageCount: number;
  preview: string;
  contextUsage: Record<string, unknown> | null;
}

export function defaultAgentSessionPath(): string {
  return path.join(defaultCacheDir(), DEFAULT_AGENT_SESSION_FILENAME);
}

export class AgentSessionStore extends BaseStore {
  constructor(dbPath: string | null = null) {
    super(dbPath ?? defaultAgentSessionPath());
  }

  protected override initSchema(conn: Database.Database): void {
    conn.exec(`
      CREATE TABLE IF NOT EXISTS agent_sessions (
        id TEXT PRIMARY KEY,
        instrument_key TEXT,
        title TEXT NOT NULL,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        created_at REAL NOT NULL,
        updated_at REAL NOT NULL,
        active INTEGER NOT NULL DEFAULT 1,
        api_mode TEXT,
        reasoning_effort TEXT
      );
      CREATE TABLE IF NOT EXISTS agent_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at REAL NOT NULL,
        analysis_json TEXT,
        context_json TEXT,
        error TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_agent_sessions_active ON agent_sessions (instrument_key, active, updated_at);
      CREATE INDEX IF NOT EXISTS idx_agent_messages_session ON agent_messages (session_id, created_at, id);
    `);
  }

  getActiveSession(instrumentKey: string): AgentSession | null {
    const row = this.getConn()
      .prepare("SELECT * FROM agent_sessions WHERE instrument_key = ? AND active = 1 ORDER BY updated_at DESC LIMIT 1")
      .get(storedInstrumentKey(instrumentKey)) as SessionRow | undefined;
    return row ? sessionFromRow(row) : null;
  }

  getSession(sessionId: string): AgentSession | null {
    const row = this.getConn().prepare("SELECT * FROM agent_sessions WHERE id = ?").get(sessionId) as SessionRow | undefined;
    return row ? sessionFromRow(row) : null;
  }

  createSession(input: { instrumentKey?: string | null; title: string; provider: string; model: string; apiMode?: string | null; reasoningEffort?: string | null }): AgentSession {
    const id = crypto.randomUUID();
    const now = Date.now() / 1000;
    const storedKey = storedInstrumentKey(input.instrumentKey ?? null);
    const title = input.title.trim() || input.instrumentKey || "New Agent Session";
    const conn = this.getConn();
    conn.prepare("UPDATE agent_sessions SET active = 0 WHERE instrument_key = ? AND active = 1").run(storedKey);
    conn.prepare(
      `INSERT INTO agent_sessions (id, instrument_key, title, provider, model, created_at, updated_at, active, api_mode, reasoning_effort)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
    ).run(id, storedKey, title, input.provider, input.model, now, now, input.apiMode ?? null, input.reasoningEffort ?? null);
    const session = this.getSession(id);
    if (!session) throw new Error("failed to create agent session");
    return session;
  }

  createGlobalSession(input: { title: string; provider: string; model: string; apiMode?: string | null; reasoningEffort?: string | null }): AgentSession {
    return this.createSession({ instrumentKey: null, ...input });
  }

  getOrCreateActiveSession(input: { instrumentKey: string; title: string; provider: string; model: string; apiMode?: string | null; reasoningEffort?: string | null }): AgentSession {
    return this.getActiveSession(input.instrumentKey) ?? this.createSession(input);
  }

  updateSessionMetadata(sessionId: string, input: { provider?: string; model?: string; apiMode?: string | null; reasoningEffort?: string | null }): AgentSession {
    const session = this.getSession(sessionId);
    if (!session) throw new Error(`session not found: ${sessionId}`);
    this.getConn()
      .prepare("UPDATE agent_sessions SET provider = ?, model = ?, api_mode = ?, reasoning_effort = ?, updated_at = ? WHERE id = ?")
      .run(input.provider ?? session.provider, input.model ?? session.model, input.apiMode ?? session.apiMode, input.reasoningEffort ?? session.reasoningEffort, Date.now() / 1000, sessionId);
    return this.getSession(sessionId)!;
  }

  renameSession(sessionId: string, title: string): AgentSession {
    this.getConn().prepare("UPDATE agent_sessions SET title = ?, updated_at = ? WHERE id = ?").run(title.trim() || "New Agent Session", Date.now() / 1000, sessionId);
    const session = this.getSession(sessionId);
    if (!session) throw new Error(`session not found: ${sessionId}`);
    return session;
  }

  appendMessage(input: { sessionId: string; role: string; content: string; metadata?: Record<string, unknown> | null; context?: Record<string, unknown> | null; error?: string | null }): AgentMessage {
    const now = Date.now() / 1000;
    const result = this.getConn()
      .prepare("INSERT INTO agent_messages (session_id, role, content, created_at, analysis_json, context_json, error) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(input.sessionId, input.role, input.content, now, input.metadata ? jsonDumps(input.metadata) : null, input.context ? jsonDumps(input.context) : null, input.error ?? null);
    this.getConn().prepare("UPDATE agent_sessions SET updated_at = ? WHERE id = ?").run(now, input.sessionId);
    const row = this.getConn().prepare("SELECT * FROM agent_messages WHERE id = ?").get(Number(result.lastInsertRowid)) as MessageRow;
    return messageFromRow(row);
  }

  listMessages(sessionId: string, input: { limit?: number | null } = {}): AgentMessage[] {
    const limit = input.limit ? `LIMIT ${Math.max(1, Math.floor(input.limit))}` : "";
    const rows = this.getConn()
      .prepare(`SELECT * FROM agent_messages WHERE session_id = ? ORDER BY created_at DESC, id DESC ${limit}`)
      .all(sessionId) as MessageRow[];
    return rows.reverse().map(messageFromRow);
  }

  sessionPayload(sessionId: string): Record<string, unknown> | null {
    const session = this.getSession(sessionId);
    if (!session) return null;
    return { ...session, messages: this.listMessages(sessionId).map((message) => messageToPayload(message, true)) };
  }

  activeSessionPayload(instrumentKey: string): Record<string, unknown> | null {
    const session = this.getActiveSession(instrumentKey);
    return session ? this.sessionPayload(session.id) : null;
  }

  listSessions(input: { instrumentKey?: string | null; limit?: number } = {}): AgentSessionSummary[] {
    const where = input.instrumentKey === undefined ? "" : "WHERE s.instrument_key = ?";
    const params = input.instrumentKey === undefined ? [] : [storedInstrumentKey(input.instrumentKey)];
    const rows = this.getConn()
      .prepare(
        `SELECT s.*, COUNT(m.id) AS message_count,
          COALESCE((SELECT SUBSTR(REPLACE(REPLACE(m1.content, X'0A', ' '), X'0D', ' '), 1, 120)
            FROM agent_messages m1 WHERE m1.session_id = s.id AND m1.role = 'user'
            ORDER BY m1.created_at, m1.id LIMIT 1), '') AS preview
         FROM agent_sessions s
         LEFT JOIN agent_messages m ON m.session_id = s.id
         ${where}
         GROUP BY s.id
         ORDER BY s.updated_at DESC, s.created_at DESC
         LIMIT ?`,
      )
      .all(...params, input.limit ?? 100) as SummaryRow[];
    return rows.map(summaryFromRow);
  }

  listAllSessions(input: { limit?: number } = {}): AgentSessionSummary[] {
    return this.listSessions({ limit: input.limit ?? 100 });
  }

  activateSession(input: { instrumentKey: string; sessionId: string }): AgentSession {
    const storedKey = storedInstrumentKey(input.instrumentKey);
    const conn = this.getConn();
    conn.prepare("UPDATE agent_sessions SET active = 0 WHERE instrument_key = ?").run(storedKey);
    conn.prepare("UPDATE agent_sessions SET active = 1, instrument_key = ?, updated_at = ? WHERE id = ?").run(storedKey, Date.now() / 1000, input.sessionId);
    const session = this.getSession(input.sessionId);
    if (!session) throw new Error(`session not found: ${input.sessionId}`);
    return session;
  }

  activateSessionById(sessionId: string): AgentSession {
    const session = this.getSession(sessionId);
    if (!session) throw new Error(`session not found: ${sessionId}`);
    return this.activateSession({ instrumentKey: session.instrumentKey ?? "", sessionId });
  }

  deleteSession(input: { instrumentKey: string; sessionId: string }): AgentSession | null {
    const session = this.getSession(input.sessionId);
    if (!session) return null;
    this.getConn().prepare("DELETE FROM agent_sessions WHERE id = ?").run(input.sessionId);
    return session;
  }

  deleteSessionById(sessionId: string): boolean {
    return this.getConn().prepare("DELETE FROM agent_sessions WHERE id = ?").run(sessionId).changes > 0;
  }

  historyForContext(sessionId: string, input: { limit?: number } = {}): Array<Record<string, unknown>> {
    return this.listMessages(sessionId, { limit: input.limit ?? 8 }).map((message) => ({ role: message.role, content: message.content }));
  }
}

interface SessionRow {
  id: string;
  instrument_key: string | null;
  title: string;
  provider: string;
  model: string;
  created_at: number;
  updated_at: number;
  active: number;
  api_mode: string | null;
  reasoning_effort: string | null;
}

interface MessageRow {
  id: number;
  session_id: string;
  role: string;
  content: string;
  created_at: number;
  analysis_json: string | null;
  context_json: string | null;
  error: string | null;
}

interface SummaryRow extends SessionRow {
  message_count: number;
  preview: string;
}

function sessionFromRow(row: SessionRow): AgentSession {
  return {
    id: row.id,
    instrumentKey: row.instrument_key || null,
    title: row.title,
    provider: row.provider,
    model: row.model,
    createdAt: isoFromTimestamp(row.created_at),
    updatedAt: isoFromTimestamp(row.updated_at),
    active: Boolean(row.active),
    apiMode: row.api_mode,
    reasoningEffort: row.reasoning_effort,
  };
}

function messageFromRow(row: MessageRow): AgentMessage {
  return {
    id: row.id,
    sessionId: row.session_id,
    role: row.role,
    content: row.content,
    createdAt: isoFromTimestamp(row.created_at),
    metadata: (jsonLoads(row.analysis_json) as Record<string, unknown>) ?? null,
    context: (jsonLoads(row.context_json) as Record<string, unknown>) ?? null,
    error: row.error,
  };
}

function summaryFromRow(row: SummaryRow): AgentSessionSummary {
  return { ...sessionFromRow(row), messageCount: row.message_count, preview: row.preview, contextUsage: null };
}

export function messageToPayload(message: AgentMessage, includeContext = false): Record<string, unknown> {
  return {
    id: message.id,
    sessionId: message.sessionId,
    role: message.role,
    content: message.content,
    createdAt: message.createdAt,
    metadata: message.metadata,
    error: message.error,
    ...(includeContext ? { context: message.context } : {}),
  };
}

function storedInstrumentKey(instrumentKey: string | null | undefined): string {
  return instrumentKey || GLOBAL_SESSION_INSTRUMENT_KEY;
}

function isoFromTimestamp(value: number): string {
  return new Date(value * 1000).toISOString();
}
