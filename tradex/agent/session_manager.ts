import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { defaultCacheDir } from "../db.js";

export const CURRENT_SESSION_VERSION = 1;

const SESSIONS_SUBDIR = "agent_sessions";

export interface SessionHeader {
  type: "session";
  version: number;
  id: string;
  timestamp: string;
  instrumentKey: string | null;
  title: string | null;
  provider: string;
  model: string;
}

export interface SessionEntryBase {
  type: string;
  id: string;
  parentId: string | null;
  timestamp: string;
}

export interface MessageEntry extends SessionEntryBase {
  type: "message";
  role: string;
  content: string;
  metadata: Record<string, unknown> | null;
  error: string | null;
}

export interface ModelChangeEntry extends SessionEntryBase {
  type: "model_change";
  provider: string;
  modelId: string;
}

export interface BranchSummaryEntry extends SessionEntryBase {
  type: "branch_summary";
  fromId: string;
  summary: string;
}

export interface CustomEntry extends SessionEntryBase {
  type: "custom";
  customType: string;
  data?: unknown;
}

export interface SessionInfoEntry extends SessionEntryBase {
  type: "session_info";
  title: string;
}

export interface LabelEntry extends SessionEntryBase {
  type: "label";
  targetId: string;
  label: string | undefined;
}

export type SessionEntry =
  | MessageEntry
  | ModelChangeEntry
  | BranchSummaryEntry
  | CustomEntry
  | SessionInfoEntry
  | LabelEntry;

export type FileEntry = SessionHeader | SessionEntry;

export interface SessionTreeNode {
  entry: SessionEntry;
  children: SessionTreeNode[];
}

export interface SessionInfo {
  path: string;
  id: string;
  instrumentKey: string | null;
  title: string | null;
  provider: string;
  model: string;
  created: Date;
  modified: Date;
  messageCount: number;
  firstMessage: string;
}

function sessionsDir(): string {
  return path.join(defaultCacheDir(), SESSIONS_SUBDIR);
}

function generateId(existing: { has(id: string): boolean }): string {
  for (let i = 0; i < 100; i++) {
    const id = crypto.randomBytes(4).toString("hex");
    if (!existing.has(id)) return id;
  }
  return crypto.randomUUID().slice(0, 8);
}

function loadEntriesFromFile(filePath: string): FileEntry[] {
  if (!fs.existsSync(filePath)) return [];
  const content = fs.readFileSync(filePath, "utf8");
  const entries: FileEntry[] = [];
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line) as FileEntry);
    } catch {
      // skip malformed
    }
  }
  if (entries.length === 0) return [];
  const header = entries[0];
  if (header.type !== "session" || typeof (header as SessionHeader).id !== "string") return [];
  return entries;
}

function buildSessionInfoFromFile(filePath: string): SessionInfo | null {
  try {
    const entries = loadEntriesFromFile(filePath);
    if (entries.length === 0) return null;
    const header = entries[0] as SessionHeader;
    if (header.type !== "session") return null;

    const stats = fs.statSync(filePath);
    let messageCount = 0;
    let firstMessage = "";
    let title: string | null = header.title;

    for (const entry of entries) {
      if (entry.type === "session_info") title = (entry as SessionInfoEntry).title || null;
      if (entry.type !== "message") continue;
      const msg = entry as MessageEntry;
      messageCount++;
      if (!firstMessage && msg.role === "user") {
        firstMessage = msg.content.replace(/[\n\r]/g, " ").slice(0, 120);
      }
    }

    let modified = stats.mtime;
    for (let i = entries.length - 1; i >= 1; i--) {
      const e = entries[i] as SessionEntry;
      if (e.timestamp) {
        const t = new Date(e.timestamp);
        if (!Number.isNaN(t.getTime())) { modified = t; break; }
      }
    }

    return {
      path: filePath,
      id: header.id,
      instrumentKey: header.instrumentKey,
      title,
      provider: header.provider,
      model: header.model,
      created: new Date(header.timestamp),
      modified,
      messageCount,
      firstMessage: firstMessage || "(no messages)",
    };
  } catch {
    return null;
  }
}

export class SessionManager {
  private sessionId = "";
  private sessionFile: string | undefined;
  private sessionDirPath: string;
  private flushed = false;
  private fileEntries: FileEntry[] = [];
  private byId: Map<string, SessionEntry> = new Map();
  private leafId: string | null = null;

  private constructor(dir: string, sessionFile: string | undefined) {
    this.sessionDirPath = dir;
    if (dir && !fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    if (sessionFile) {
      this.loadSessionFile(sessionFile);
    }
  }

  private loadSessionFile(filePath: string): void {
    this.sessionFile = path.resolve(filePath);
    if (fs.existsSync(this.sessionFile)) {
      this.fileEntries = loadEntriesFromFile(this.sessionFile);
      if (this.fileEntries.length === 0) {
        this.sessionFile = undefined;
        return;
      }
      const header = this.fileEntries[0] as SessionHeader;
      this.sessionId = header.id;
      this.buildIndex();
      this.flushed = true;
    }
  }

  private buildIndex(): void {
    this.byId.clear();
    this.leafId = null;
    for (const entry of this.fileEntries) {
      if (entry.type === "session") continue;
      this.byId.set(entry.id, entry as SessionEntry);
      this.leafId = entry.id;
    }
  }

  private rewriteFile(): void {
    if (!this.sessionFile) return;
    const content = this.fileEntries.map((e) => JSON.stringify(e)).join("\n") + "\n";
    fs.writeFileSync(this.sessionFile, content);
  }

  private persist(entry: SessionEntry): void {
    if (!this.sessionFile) return;

    const hasAssistant = this.fileEntries.some(
      (e) => e.type === "message" && (e as MessageEntry).role === "assistant",
    );
    if (!hasAssistant) {
      this.flushed = false;
      return;
    }

    if (!this.flushed) {
      const content = this.fileEntries.map((e) => JSON.stringify(e)).join("\n") + "\n";
      fs.writeFileSync(this.sessionFile, content);
      this.flushed = true;
    } else {
      fs.appendFileSync(this.sessionFile, JSON.stringify(entry) + "\n");
    }
  }

  private appendEntry(entry: SessionEntry): void {
    this.fileEntries.push(entry);
    this.byId.set(entry.id, entry);
    this.leafId = entry.id;
    this.persist(entry);
  }

  // =========================================================================
  // Static factory methods
  // =========================================================================

  static create(instrumentKey: string | null, options?: { title?: string; provider?: string; model?: string }): SessionManager {
    const dir = sessionsDir();
    const mgr = new SessionManager(dir, undefined);
    mgr.newSession({ instrumentKey, ...options });
    return mgr;
  }

  static open(filePath: string): SessionManager {
    const dir = path.dirname(path.resolve(filePath));
    return new SessionManager(dir, filePath);
  }

  static continueRecent(instrumentKey?: string | null): SessionManager {
    const dir = sessionsDir();
    if (!fs.existsSync(dir)) {
      const mgr = new SessionManager(dir, undefined);
      mgr.newSession({ instrumentKey: instrumentKey ?? null });
      return mgr;
    }
    const files = fs.readdirSync(dir)
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => path.join(dir, f));

    let best: { path: string; mtime: number } | null = null;
    for (const file of files) {
      if (instrumentKey !== undefined && instrumentKey !== null) {
        const entries = loadEntriesFromFile(file);
        if (entries.length === 0) continue;
        const header = entries[0] as SessionHeader;
        if (header.instrumentKey !== instrumentKey) continue;
      }
      try {
        const st = fs.statSync(file);
        if (!best || st.mtime.getTime() > best.mtime) {
          best = { path: file, mtime: st.mtime.getTime() };
        }
      } catch { /* skip */ }
    }

    if (best) return new SessionManager(dir, best.path);
    const mgr = new SessionManager(dir, undefined);
    mgr.newSession({ instrumentKey: instrumentKey ?? null });
    return mgr;
  }

  static list(instrumentKey?: string | null): SessionInfo[] {
    const dir = sessionsDir();
    if (!fs.existsSync(dir)) return [];
    const files = fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl")).map((f) => path.join(dir, f));
    const results: SessionInfo[] = [];
    for (const file of files) {
      const info = buildSessionInfoFromFile(file);
      if (!info) continue;
      if (instrumentKey !== undefined && instrumentKey !== null && info.instrumentKey !== instrumentKey) continue;
      results.push(info);
    }
    results.sort((a, b) => b.modified.getTime() - a.modified.getTime());
    return results;
  }

  static listAll(): SessionInfo[] {
    return SessionManager.list(undefined);
  }

  static deleteSession(sessionId: string): boolean {
    const dir = sessionsDir();
    if (!fs.existsSync(dir)) return false;
    const files = fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
    for (const file of files) {
      if (file.includes(sessionId)) {
        fs.unlinkSync(path.join(dir, file));
        return true;
      }
    }
    const allFiles = files.map((f) => path.join(dir, f));
    for (const file of allFiles) {
      const entries = loadEntriesFromFile(file);
      if (entries.length > 0 && (entries[0] as SessionHeader).id === sessionId) {
        fs.unlinkSync(file);
        return true;
      }
    }
    return false;
  }

  // =========================================================================
  // Instance methods - Session lifecycle
  // =========================================================================

  newSession(options?: { instrumentKey?: string | null; title?: string; provider?: string; model?: string }): string | undefined {
    this.sessionId = crypto.randomUUID();
    const timestamp = new Date().toISOString();
    const header: SessionHeader = {
      type: "session",
      version: CURRENT_SESSION_VERSION,
      id: this.sessionId,
      timestamp,
      instrumentKey: options?.instrumentKey ?? null,
      title: options?.title ?? null,
      provider: options?.provider ?? "codex",
      model: options?.model ?? "codex-mini",
    };
    this.fileEntries = [header];
    this.byId.clear();
    this.leafId = null;
    this.flushed = false;

    const fileTimestamp = timestamp.replace(/[:.]/g, "-");
    this.sessionFile = path.join(this.sessionDirPath, `${fileTimestamp}_${this.sessionId}.jsonl`);
    return this.sessionFile;
  }

  // =========================================================================
  // Append methods
  // =========================================================================

  appendMessage(message: { role: string; content: string; metadata?: Record<string, unknown> | null; error?: string | null }): string {
    const entry: MessageEntry = {
      type: "message",
      id: generateId(this.byId),
      parentId: this.leafId,
      timestamp: new Date().toISOString(),
      role: message.role,
      content: message.content,
      metadata: message.metadata ?? null,
      error: message.error ?? null,
    };
    this.appendEntry(entry);
    return entry.id;
  }

  appendModelChange(provider: string, modelId: string): string {
    const entry: ModelChangeEntry = {
      type: "model_change",
      id: generateId(this.byId),
      parentId: this.leafId,
      timestamp: new Date().toISOString(),
      provider,
      modelId,
    };
    this.appendEntry(entry);
    return entry.id;
  }

  appendBranchSummary(fromId: string, summary: string): string {
    const entry: BranchSummaryEntry = {
      type: "branch_summary",
      id: generateId(this.byId),
      parentId: this.leafId,
      timestamp: new Date().toISOString(),
      fromId,
      summary,
    };
    this.appendEntry(entry);
    return entry.id;
  }

  appendCustomEntry(customType: string, data?: unknown): string {
    const entry: CustomEntry = {
      type: "custom",
      id: generateId(this.byId),
      parentId: this.leafId,
      timestamp: new Date().toISOString(),
      customType,
      data,
    };
    this.appendEntry(entry);
    return entry.id;
  }

  appendSessionInfo(title: string): string {
    const entry: SessionInfoEntry = {
      type: "session_info",
      id: generateId(this.byId),
      parentId: this.leafId,
      timestamp: new Date().toISOString(),
      title: title.trim(),
    };
    this.appendEntry(entry);
    return entry.id;
  }

  appendLabelChange(targetId: string, label: string | undefined): string {
    if (!this.byId.has(targetId)) {
      throw new Error(`Entry ${targetId} not found`);
    }
    const entry: LabelEntry = {
      type: "label",
      id: generateId(this.byId),
      parentId: this.leafId,
      timestamp: new Date().toISOString(),
      targetId,
      label,
    };
    this.appendEntry(entry);
    return entry.id;
  }

  // =========================================================================
  // Branching
  // =========================================================================

  branch(entryId: string): void {
    if (!this.byId.has(entryId)) {
      throw new Error(`Entry ${entryId} not found`);
    }
    this.leafId = entryId;
  }

  branchWithSummary(entryId: string, summary: string): string {
    this.branch(entryId);
    return this.appendBranchSummary(entryId, summary);
  }

  // =========================================================================
  // Tree traversal / queries
  // =========================================================================

  getLeafId(): string | null {
    return this.leafId;
  }

  getLeafEntry(): SessionEntry | undefined {
    return this.leafId ? this.byId.get(this.leafId) : undefined;
  }

  getEntry(id: string): SessionEntry | undefined {
    return this.byId.get(id);
  }

  getEntries(): SessionEntry[] {
    return this.fileEntries.filter((e): e is SessionEntry => e.type !== "session");
  }

  getHeader(): SessionHeader | null {
    const h = this.fileEntries.find((e) => e.type === "session");
    return h ? (h as SessionHeader) : null;
  }

  getSessionId(): string {
    return this.sessionId;
  }

  getSessionFile(): string | undefined {
    return this.sessionFile;
  }

  getSessionName(): string | null {
    const entries = this.getEntries();
    for (let i = entries.length - 1; i >= 0; i--) {
      if (entries[i].type === "session_info") {
        return (entries[i] as SessionInfoEntry).title || null;
      }
    }
    const header = this.getHeader();
    return header?.title ?? null;
  }

  getBranch(fromId?: string): SessionEntry[] {
    const result: SessionEntry[] = [];
    const startId = fromId ?? this.leafId;
    let current = startId ? this.byId.get(startId) : undefined;
    while (current) {
      result.unshift(current);
      current = current.parentId ? this.byId.get(current.parentId) : undefined;
    }
    return result;
  }

  getTree(): SessionTreeNode[] {
    const entries = this.getEntries();
    const nodeMap = new Map<string, SessionTreeNode>();
    const roots: SessionTreeNode[] = [];

    for (const entry of entries) {
      nodeMap.set(entry.id, { entry, children: [] });
    }
    for (const entry of entries) {
      const node = nodeMap.get(entry.id)!;
      if (!entry.parentId) {
        roots.push(node);
      } else {
        const parent = nodeMap.get(entry.parentId);
        if (parent) parent.children.push(node);
        else roots.push(node);
      }
    }
    return roots;
  }

  buildSessionContext(): Array<Record<string, unknown>> {
    const branch = this.getBranch();
    if (branch.length === 0) return [];

    let lastCompactionIdx = -1;
    for (let i = branch.length - 1; i >= 0; i--) {
      if (branch[i].type === "branch_summary" && (branch[i] as BranchSummaryEntry).summary) {
        // branch_summary is handled inline
      }
      // We don't have compaction in v1, but keeping the pattern for future
    }

    const messages: Array<Record<string, unknown>> = [];
    for (const entry of branch) {
      if (entry.type === "message") {
        const msg = entry as MessageEntry;
        messages.push({ role: msg.role, content: msg.content });
      } else if (entry.type === "branch_summary") {
        const bs = entry as BranchSummaryEntry;
        messages.push({ role: "system", content: `[Branch context]\n${bs.summary}` });
      }
    }
    return messages;
  }

  historyForContext(options?: { limit?: number }): Array<Record<string, unknown>> {
    const context = this.buildSessionContext();
    const limit = options?.limit ?? 8;
    if (context.length <= limit) return context;
    return context.slice(-limit);
  }

  // =========================================================================
  // Payload helpers (API compatibility)
  // =========================================================================

  sessionPayload(): Record<string, unknown> {
    const header = this.getHeader();
    if (!header) return { session: null, messages: [] };
    const entries = this.getEntries();
    const messageEntries = entries.filter((e): e is MessageEntry => e.type === "message");
    return {
      session: {
        id: header.id,
        instrumentKey: header.instrumentKey,
        title: this.getSessionName() || header.title || "New Agent Session",
        provider: header.provider,
        model: header.model,
        createdAt: header.timestamp,
        updatedAt: entries.length > 0 ? entries[entries.length - 1].timestamp : header.timestamp,
        active: true,
        apiMode: null,
        reasoningEffort: null,
        leafId: this.leafId,
      },
      messages: messageEntries.map((msg) => ({
        id: msg.id,
        sessionId: header.id,
        role: msg.role,
        content: msg.content,
        createdAt: msg.timestamp,
        metadata: msg.metadata,
        error: msg.error,
        entryId: msg.id,
        parentId: msg.parentId,
        entryType: "message",
      })),
      contextUsage: null,
    };
  }

  listSessionSummaries(): Array<Record<string, unknown>> {
    const all = SessionManager.listAll();
    return all.map((info) => ({
      id: info.id,
      instrumentKey: info.instrumentKey,
      title: info.title || info.firstMessage.slice(0, 60),
      provider: info.provider,
      model: info.model,
      createdAt: info.created.toISOString(),
      updatedAt: info.modified.toISOString(),
      active: false,
      apiMode: null,
      reasoningEffort: null,
      leafId: null,
      messageCount: info.messageCount,
      preview: info.firstMessage,
      contextUsage: null,
    }));
  }
}
