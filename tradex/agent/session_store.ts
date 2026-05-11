import Database from "better-sqlite3";
import crypto from "node:crypto";
import path from "node:path";
import { BaseStore, defaultCacheDir, jsonDumps, jsonLoads } from "../db.js";

export const DEFAULT_AGENT_SESSION_FILENAME = "agent_sessions.sqlite3";
const GLOBAL_SESSION_INSTRUMENT_KEY = "";

export type EntryType = "message" | "compaction" | "branch_summary" | "model_change";

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
  leafId: string | null;
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
  entryId: string;
  parentId: string | null;
  entryType: EntryType;
}

export interface AgentSessionSummary extends AgentSession {
  messageCount: number;
  preview: string;
  contextUsage: Record<string, unknown> | null;
}

export interface SessionTreeNode {
  entry: AgentMessage;
  children: SessionTreeNode[];
}

export function defaultAgentSessionPath(): string {
  return path.join(defaultCacheDir(), DEFAULT_AGENT_SESSION_FILENAME);
}

function generateEntryId(): string {
  return crypto.randomBytes(4).toString("hex");
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
        reasoning_effort TEXT,
        leaf_id TEXT
      );
      CREATE TABLE IF NOT EXISTS agent_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at REAL NOT NULL,
        analysis_json TEXT,
        context_json TEXT,
        error TEXT,
        entry_id TEXT,
        parent_id TEXT,
        entry_type TEXT NOT NULL DEFAULT 'message'
      );
      CREATE INDEX IF NOT EXISTS idx_agent_sessions_active ON agent_sessions (instrument_key, active, updated_at);
      CREATE INDEX IF NOT EXISTS idx_agent_messages_session ON agent_messages (session_id, created_at, id);
      CREATE INDEX IF NOT EXISTS idx_agent_messages_entry_id ON agent_messages (session_id, entry_id);
    `);
    ensureAgentSessionColumns(conn);
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
      `INSERT INTO agent_sessions (id, instrument_key, title, provider, model, created_at, updated_at, active, api_mode, reasoning_effort, leaf_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, NULL)`,
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

  appendMessage(input: { sessionId: string; role: string; content: string; metadata?: Record<string, unknown> | null; context?: Record<string, unknown> | null; error?: string | null; entryType?: EntryType }): AgentMessage {
    const now = Date.now() / 1000;
    const entryId = generateEntryId();
    const entryType = input.entryType ?? "message";
    const session = this.getSession(input.sessionId);
    const parentId = session?.leafId ?? null;
    const conn = this.getConn();
    const result = conn
      .prepare("INSERT INTO agent_messages (session_id, role, content, created_at, analysis_json, context_json, error, entry_id, parent_id, entry_type) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(input.sessionId, input.role, input.content, now, input.metadata ? jsonDumps(input.metadata) : null, input.context ? jsonDumps(input.context) : null, input.error ?? null, entryId, parentId, entryType);
    conn.prepare("UPDATE agent_sessions SET updated_at = ?, leaf_id = ? WHERE id = ?").run(now, entryId, input.sessionId);
    const row = conn.prepare("SELECT * FROM agent_messages WHERE id = ?").get(Number(result.lastInsertRowid)) as MessageRow;
    return messageFromRow(row);
  }

  appendCompaction(input: { sessionId: string; summary: string; firstKeptEntryId: string; tokensBefore: number }): AgentMessage {
    return this.appendMessage({
      sessionId: input.sessionId,
      role: "system",
      content: input.summary,
      entryType: "compaction",
      metadata: { firstKeptEntryId: input.firstKeptEntryId, tokensBefore: input.tokensBefore },
    });
  }

  appendBranchSummary(input: { sessionId: string; fromId: string; summary: string }): AgentMessage {
    return this.appendMessage({
      sessionId: input.sessionId,
      role: "system",
      content: input.summary,
      entryType: "branch_summary",
      metadata: { fromId: input.fromId },
    });
  }

  appendModelChange(input: { sessionId: string; provider: string; model: string }): AgentMessage {
    return this.appendMessage({
      sessionId: input.sessionId,
      role: "system",
      content: `Model changed to ${input.provider}/${input.model}`,
      entryType: "model_change",
      metadata: { provider: input.provider, model: input.model },
    });
  }

  branch(input: { sessionId: string; entryId: string }): void {
    const msg = this.getConn()
      .prepare("SELECT entry_id FROM agent_messages WHERE session_id = ? AND entry_id = ?")
      .get(input.sessionId, input.entryId) as { entry_id: string } | undefined;
    if (!msg) throw new Error(`entry ${input.entryId} not found in session ${input.sessionId}`);
    this.getConn().prepare("UPDATE agent_sessions SET leaf_id = ?, updated_at = ? WHERE id = ?").run(input.entryId, Date.now() / 1000, input.sessionId);
  }

  getBranch(input: { sessionId: string; fromId?: string | null }): AgentMessage[] {
    const session = this.getSession(input.sessionId);
    if (!session) return [];
    const startId = input.fromId ?? session.leafId;
    if (!startId) return [];

    const allRows = this.getConn()
      .prepare("SELECT * FROM agent_messages WHERE session_id = ? ORDER BY created_at, id")
      .all(input.sessionId) as MessageRow[];
    const byEntryId = new Map<string, MessageRow>();
    for (const row of allRows) {
      if (row.entry_id) byEntryId.set(row.entry_id, row);
    }

    const path: MessageRow[] = [];
    let currentId: string | null = startId;
    while (currentId) {
      const row = byEntryId.get(currentId);
      if (!row) break;
      path.unshift(row);
      currentId = row.parent_id;
    }
    return path.map(messageFromRow);
  }

  buildSessionContext(sessionId: string): Array<Record<string, unknown>> {
    const branch = this.getBranch({ sessionId });
    if (branch.length === 0) return [];

    let lastCompactionIdx = -1;
    for (let i = branch.length - 1; i >= 0; i--) {
      if (branch[i].entryType === "compaction") { lastCompactionIdx = i; break; }
    }

    if (lastCompactionIdx >= 0) {
      const compaction = branch[lastCompactionIdx];
      const meta = compaction.metadata as Record<string, unknown> | null;
      const firstKeptEntryId = meta?.firstKeptEntryId as string | undefined;

      const messages: Array<Record<string, unknown>> = [];
      messages.push({ role: "system", content: `[Previous conversation summary]\n${compaction.content}` });

      if (firstKeptEntryId) {
        const keptStartIdx = branch.findIndex((m) => m.entryId === firstKeptEntryId);
        if (keptStartIdx >= 0 && keptStartIdx < lastCompactionIdx) {
          for (let i = keptStartIdx; i < lastCompactionIdx; i++) {
            const m = branch[i];
            if (m.entryType === "message") messages.push({ role: m.role, content: m.content });
          }
        }
      }

      for (let i = lastCompactionIdx + 1; i < branch.length; i++) {
        const m = branch[i];
        if (m.entryType === "message") messages.push({ role: m.role, content: m.content });
        else if (m.entryType === "branch_summary") messages.push({ role: "system", content: `[Branch context]\n${m.content}` });
      }
      return messages;
    }

    const messages: Array<Record<string, unknown>> = [];
    for (const m of branch) {
      if (m.entryType === "message") messages.push({ role: m.role, content: m.content });
      else if (m.entryType === "branch_summary") messages.push({ role: "system", content: `[Branch context]\n${m.content}` });
    }
    return messages;
  }

  getTree(sessionId: string): SessionTreeNode[] {
    const allRows = this.getConn()
      .prepare("SELECT * FROM agent_messages WHERE session_id = ? ORDER BY created_at, id")
      .all(sessionId) as MessageRow[];
    const messages = allRows.map(messageFromRow);
    const nodeMap = new Map<string, SessionTreeNode>();
    const roots: SessionTreeNode[] = [];

    for (const msg of messages) {
      nodeMap.set(msg.entryId, { entry: msg, children: [] });
    }

    for (const msg of messages) {
      const node = nodeMap.get(msg.entryId)!;
      if (!msg.parentId) {
        roots.push(node);
      } else {
        const parent = nodeMap.get(msg.parentId);
        if (parent) parent.children.push(node);
        else roots.push(node);
      }
    }
    return roots;
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
    return {
      session,
      messages: this.listMessages(sessionId).map((message) => messageToPayload(message, true)),
      contextUsage: null,
    };
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
    const context = this.buildSessionContext(sessionId);
    const limit = input.limit ?? 8;
    if (context.length <= limit) return context;
    return context.slice(-limit);
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
  leaf_id: string | null;
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
  entry_id: string | null;
  parent_id: string | null;
  entry_type: string | null;
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
    leafId: row.leaf_id ?? null,
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
    entryId: row.entry_id ?? `legacy_${row.id}`,
    parentId: row.parent_id ?? null,
    entryType: (row.entry_type as EntryType) ?? "message",
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
    entryId: message.entryId,
    parentId: message.parentId,
    entryType: message.entryType,
    ...(includeContext ? { context: message.context } : {}),
  };
}

function storedInstrumentKey(instrumentKey: string | null | undefined): string {
  return instrumentKey || GLOBAL_SESSION_INSTRUMENT_KEY;
}

function isoFromTimestamp(value: number): string {
  return new Date(value * 1000).toISOString();
}

function ensureAgentSessionColumns(conn: Database.Database): void {
  const sessionRows = conn.prepare("PRAGMA table_info(agent_sessions)").all() as Array<{ name: string }>;
  const sessionColumns = new Set(sessionRows.map((row) => row.name));
  if (!sessionColumns.has("api_mode")) conn.exec("ALTER TABLE agent_sessions ADD COLUMN api_mode TEXT");
  if (!sessionColumns.has("reasoning_effort")) conn.exec("ALTER TABLE agent_sessions ADD COLUMN reasoning_effort TEXT");
  if (!sessionColumns.has("leaf_id")) conn.exec("ALTER TABLE agent_sessions ADD COLUMN leaf_id TEXT");

  const msgRows = conn.prepare("PRAGMA table_info(agent_messages)").all() as Array<{ name: string }>;
  const msgColumns = new Set(msgRows.map((row) => row.name));
  if (!msgColumns.has("entry_id")) conn.exec("ALTER TABLE agent_messages ADD COLUMN entry_id TEXT");
  if (!msgColumns.has("parent_id")) conn.exec("ALTER TABLE agent_messages ADD COLUMN parent_id TEXT");
  if (!msgColumns.has("entry_type")) conn.exec("ALTER TABLE agent_messages ADD COLUMN entry_type TEXT NOT NULL DEFAULT 'message'");

  migrateLinearToTree(conn);
}

function migrateLinearToTree(conn: Database.Database): void {
  const sessionsNeedingMigration = conn.prepare(
    "SELECT DISTINCT session_id FROM agent_messages WHERE entry_id IS NULL",
  ).all() as Array<{ session_id: string }>;

  if (sessionsNeedingMigration.length === 0) return;

  const updateMsg = conn.prepare("UPDATE agent_messages SET entry_id = ?, parent_id = ? WHERE id = ?");
  const updateLeaf = conn.prepare("UPDATE agent_sessions SET leaf_id = ? WHERE id = ?");

  const migrateTransaction = conn.transaction(() => {
    for (const { session_id } of sessionsNeedingMigration) {
      const rows = conn.prepare(
        "SELECT id FROM agent_messages WHERE session_id = ? AND entry_id IS NULL ORDER BY created_at, id",
      ).all(session_id) as Array<{ id: number }>;

      let prevEntryId: string | null = null;
      let lastEntryId: string | null = null;

      const existingLeaf = conn.prepare(
        "SELECT entry_id FROM agent_messages WHERE session_id = ? AND entry_id IS NOT NULL ORDER BY created_at DESC, id DESC LIMIT 1",
      ).get(session_id) as { entry_id: string } | undefined;
      if (existingLeaf) prevEntryId = existingLeaf.entry_id;

      for (const row of rows) {
        const entryId = generateEntryId();
        updateMsg.run(entryId, prevEntryId, row.id);
        prevEntryId = entryId;
        lastEntryId = entryId;
      }

      if (lastEntryId) {
        const currentSession = conn.prepare("SELECT leaf_id FROM agent_sessions WHERE id = ?").get(session_id) as { leaf_id: string | null } | undefined;
        if (!currentSession?.leaf_id) {
          updateLeaf.run(lastEntryId, session_id);
        }
      }
    }
  });

  migrateTransaction();
}
