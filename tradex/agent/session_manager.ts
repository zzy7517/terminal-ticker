import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { defaultCacheDir } from "../db.js";
import type { SessionIndex } from "./session_index.js";

export const CURRENT_SESSION_VERSION = 1;

const SESSIONS_SUBDIR = "agent_sessions";

export interface SessionHeader {
  type: "session";
  version: number;
  id: string;
  timestamp: string;
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
  title: string | null;
  provider: string;
  model: string;
  created: Date;
  modified: Date;
  messageCount: number;
  firstMessage: string;
}

const EXTERNAL_CONTEXT_TOOL_NAMES = new Set([
  "web_search",
  "web_fetch",
  "get_recent_news",
  "refresh_news",
  "refresh_x_following_feed",
  "get_recent_social_feed",
  "search_x_tweets",
  "browser_open_page",
  "browser_screenshot",
  "browser_status",
]);

function toolNamePollutesMemory(toolName: unknown): boolean {
  const name = String(toolName ?? "").trim();
  return Boolean(name && (EXTERNAL_CONTEXT_TOOL_NAMES.has(name) || name.startsWith("mcp:")));
}

function messageHasExternalContext(msg: MessageEntry): boolean {
  const metadata = msg.metadata ?? {};
  if (metadata.memoryExternalContext === true) return true;
  if (toolNamePollutesMemory(metadata.toolName)) return true;
  const toolCalls = Array.isArray(metadata.toolCalls) ? metadata.toolCalls : [];
  return toolCalls.some((toolCall) =>
    toolCall && typeof toolCall === "object" && toolNamePollutesMemory((toolCall as Record<string, unknown>).name)
  );
}

// Returns the directory where all session JSONL files are stored.
function sessionsDir(): string {
  return path.join(defaultCacheDir(), SESSIONS_SUBDIR);
}

// Generates a short random hex ID that does not collide with any existing key
// in `existing`. Falls back to a UUID prefix after 100 attempts.
function generateId(existing: { has(id: string): boolean }): string {
  for (let i = 0; i < 100; i++) {
    const id = crypto.randomBytes(4).toString("hex");
    if (!existing.has(id)) return id;
  }
  return crypto.randomUUID().slice(0, 8);
}

// Reads a JSONL session file and returns all parsed entries. Returns an empty
// array if the file is missing, empty, or has an invalid header on line 1.
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

// Reads a session file and builds the lightweight SessionInfo summary used by
// the index and the sessions list UI. Returns null for unreadable or malformed files.
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

    // Prefer the timestamp on the last entry over the filesystem mtime so the
    // modified time stays accurate even after a file copy or backup restore.
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
  private index: SessionIndex | null = null;

  // Private to enforce use of the static factory methods, which handle async
  // file/directory setup before the instance is usable.
  private constructor(dir: string, sessionFile: string | undefined, index?: SessionIndex | null) {
    this.sessionDirPath = dir;
    this.index = index ?? null;
    if (dir && !fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    if (sessionFile) {
      this.loadSessionFile(sessionFile);
    }
  }

  // Attaches or replaces the SessionIndex used for fast lookups without disk scans.
  setIndex(index: SessionIndex | null): void {
    this.index = index;
  }

  // Rebuilds the full index row for this session from the current file on disk.
  private syncIndex(): void {
    if (!this.index || !this.sessionFile) return;
    const info = buildSessionInfoFromFile(this.sessionFile);
    if (info) this.index.upsert(info);
  }

  // Updates only the activity timestamp and message count without re-reading the file.
  // Skipped before the first flush because the file may not exist yet.
  private syncIndexActivity(): void {
    if (!this.index || !this.flushed) return;
    const messageCount = this.fileEntries.filter((e) => e.type === "message").length;
    this.index.updateActivity(this.sessionId, new Date(), messageCount);
  }

  // Reads an existing JSONL file into memory and sets flushed=true so
  // subsequent appends can use appendFileSync instead of a full rewrite.
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

  // Rebuilds the in-memory byId map and advances leafId to the last entry.
  // Called after loading a file or after a branch rewrite.
  private buildIndex(): void {
    this.byId.clear();
    this.leafId = null;
    for (const entry of this.fileEntries) {
      if (entry.type === "session") continue;
      this.byId.set(entry.id, entry as SessionEntry);
      this.leafId = entry.id;
    }
  }

  // Serializes all in-memory entries back to disk as JSONL. Used after an
  // in-place mutation (updateMessage) where appendFileSync is not safe.
  private rewriteFile(): void {
    if (!this.sessionFile || !this.flushed) return;
    const content = this.fileEntries.map((e) => JSON.stringify(e)).join("\n") + "\n";
    fs.writeFileSync(this.sessionFile, content);
  }

  // Writes a single entry to disk. Defers the first write until an assistant
  // message is present so we don't create files for user-only interactions
  // that the agent never responded to. On the first real flush, writes all
  // buffered entries at once; subsequent appends use appendFileSync.
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
      this.syncIndex();
    } else {
      fs.appendFileSync(this.sessionFile, JSON.stringify(entry) + "\n");
    }
  }

  // Adds an entry to the in-memory structures, advances the leaf pointer,
  // persists to disk, and notifies the index.
  private appendEntry(entry: SessionEntry): void {
    this.fileEntries.push(entry);
    this.byId.set(entry.id, entry);
    this.leafId = entry.id;
    this.persist(entry);
    this.syncIndexActivity();
  }

  // =========================================================================
  // Static factory methods
  // =========================================================================

  // Creates a brand-new session with a generated UUID and an empty JSONL file
  // path (the file is not written until the first assistant message is persisted).
  static create(options?: { title?: string; provider?: string; model?: string; index?: SessionIndex | null }): SessionManager {
    const dir = sessionsDir();
    const mgr = new SessionManager(dir, undefined, options?.index);
    mgr.newSession({ title: options?.title, provider: options?.provider, model: options?.model });
    return mgr;
  }

  // Opens an existing session JSONL file and loads it into memory.
  static open(filePath: string, index?: SessionIndex | null): SessionManager {
    const dir = path.dirname(path.resolve(filePath));
    return new SessionManager(dir, filePath, index);
  }

  // Lists all sessions on disk, sorted by most recently modified.
  static list(): SessionInfo[] {
    const dir = sessionsDir();
    if (!fs.existsSync(dir)) return [];
    const files = fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl")).map((f) => path.join(dir, f));
    const results: SessionInfo[] = [];
    for (const file of files) {
      const info = buildSessionInfoFromFile(file);
      if (!info) continue;
      results.push(info);
    }
    results.sort((a, b) => b.modified.getTime() - a.modified.getTime());
    return results;
  }

  // Convenience wrapper over `list`.
  static listAll(): SessionInfo[] {
    return SessionManager.list();
  }

  // Syncs the full disk session list into the in-memory index on startup,
  // so subsequent lookups can avoid repeated directory scans.
  static reconcileIndex(index: SessionIndex): void {
    const sessions = SessionManager.listAll();
    index.reconcile(sessions);
  }

  // Deletes a session file by sessionId. First tries a fast filename-substring
  // match, then falls back to loading each file's header to find the right one.
  static deleteSession(sessionId: string, index?: SessionIndex | null): boolean {
    const dir = sessionsDir();
    if (!fs.existsSync(dir)) return false;
    let deleted = false;
    const files = fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
    for (const file of files) {
      if (file.includes(sessionId)) {
        fs.unlinkSync(path.join(dir, file));
        deleted = true;
        break;
      }
    }
    if (!deleted) {
      const allFiles = files.map((f) => path.join(dir, f));
      for (const file of allFiles) {
        const entries = loadEntriesFromFile(file);
        if (entries.length > 0 && (entries[0] as SessionHeader).id === sessionId) {
          fs.unlinkSync(file);
          deleted = true;
          break;
        }
      }
    }
    if (deleted) index?.deleteSession(sessionId);
    return deleted;
  }

  // =========================================================================
  // Instance methods - Session lifecycle
  // =========================================================================

  // Resets the manager to a fresh session state and computes the target file
  // path. The file is not written until the first assistant message is appended.
  newSession(options?: { title?: string; provider?: string; model?: string }): string | undefined {
    this.sessionId = crypto.randomUUID();
    const timestamp = new Date().toISOString();
    const header: SessionHeader = {
      type: "session",
      version: CURRENT_SESSION_VERSION,
      id: this.sessionId,
      timestamp,
      title: options?.title ?? null,
      provider: options?.provider ?? "codex",
      model: options?.model ?? "codex-mini",
    };
    this.fileEntries = [header];
    this.byId.clear();
    this.leafId = null;

    const fileTimestamp = timestamp.replace(/[:.]/g, "-");
    this.sessionFile = path.join(this.sessionDirPath, `${fileTimestamp}_${this.sessionId}.jsonl`);
    this.flushed = false;
    return this.sessionFile;
  }

  // =========================================================================
  // Append methods
  // =========================================================================

  // Appends a chat message (user, assistant, or toolResult) as a new leaf entry.
  // Returns the generated entry ID so callers can later patch or reference it.
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

  // Mutates an existing message entry in-place and rewrites the whole file.
  // Used to backfill the assistant placeholder created before the agent run.
  updateMessage(entryId: string, patch: { content?: string; metadata?: Record<string, unknown> | null; error?: string | null }): MessageEntry {
    const entry = this.byId.get(entryId);
    if (!entry || entry.type !== "message") throw new Error(`message entry not found: ${entryId}`);
    const message = entry as MessageEntry;
    if (patch.content !== undefined) message.content = patch.content;
    if (patch.metadata !== undefined) message.metadata = patch.metadata;
    if (patch.error !== undefined) message.error = patch.error;
    this.rewriteFile();
    this.syncIndex();
    return message;
  }

  // Records a provider/model switch event in the session history.
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

  // Records a branch point, storing the condensed summary that replaces the
  // truncated history when LLM context is rebuilt from this branch.
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

  // Appends an arbitrary typed payload for extensibility without schema changes.
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

  // Appends a session title update. The most recent session_info entry wins
  // over the original header title when the session name is resolved.
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

  // Attaches or removes a human-readable label from a specific entry.
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

  // Resets the leaf pointer to an earlier entry, causing subsequent appends
  // to fork off from that point rather than extending the current tail.
  branch(entryId: string): void {
    if (!this.byId.has(entryId)) {
      throw new Error(`Entry ${entryId} not found`);
    }
    this.leafId = entryId;
  }

  // Branches at entryId and immediately records a summary of the truncated
  // history so the LLM context can be reconstructed without the full prior thread.
  branchWithSummary(entryId: string, summary: string): string {
    this.branch(entryId);
    return this.appendBranchSummary(entryId, summary);
  }

  // =========================================================================
  // Tree traversal / queries
  // =========================================================================

  // Returns the ID of the current leaf (most recently appended or branched-to entry).
  getLeafId(): string | null {
    return this.leafId;
  }

  // Returns the leaf entry object, or undefined if the session is empty.
  getLeafEntry(): SessionEntry | undefined {
    return this.leafId ? this.byId.get(this.leafId) : undefined;
  }

  // Looks up a single entry by ID.
  getEntry(id: string): SessionEntry | undefined {
    return this.byId.get(id);
  }

  // Returns all non-header entries in file order.
  getEntries(): SessionEntry[] {
    return this.fileEntries.filter((e): e is SessionEntry => e.type !== "session");
  }

  // Returns the parsed session header, or null for a newly created session
  // whose header has not yet been flushed.
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

  // Resolves the display name by scanning entries in reverse for the latest
  // session_info record, falling back to the original header title.
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

  // Walks the parentId chain from fromId (or the current leaf) back to the
  // root, returning the entries in chronological order. This is the active
  // branch of the conversation tree — entries on other branches are excluded.
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

  // Builds the full entry tree as a forest of SessionTreeNode objects.
  // Entries whose parentId points to an unknown node are treated as roots.
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

  // Converts the active branch into the message array format expected by LLM
  // provider APIs. branch_summary entries are injected as system messages so
  // condensed history from prior branches is preserved in context.
  buildSessionContext(): Array<Record<string, unknown>> {
    const branch = this.getBranch();
    if (branch.length === 0) return [];

    const messages: Array<Record<string, unknown>> = [];
    for (const entry of branch) {
      if (entry.type === "message") {
        const msg = entry as MessageEntry;
        messages.push({ role: msg.role, content: msg.content, metadata: msg.metadata });
      } else if (entry.type === "branch_summary") {
        const bs = entry as BranchSummaryEntry;
        messages.push({ role: "system", content: `[Branch context]\n${bs.summary}` });
      }
    }
    return messages;
  }

  // =========================================================================
  // Payload helpers (API compatibility)
  // =========================================================================

  // Serializes the session header and all message entries into the REST API
  // shape consumed by the frontend session panel.
  sessionPayload(): Record<string, unknown> {
    const header = this.getHeader();
    if (!header) return { session: null, messages: [] };
    const entries = this.getEntries();
    const messageEntries = entries.filter((e): e is MessageEntry => e.type === "message");
    const hasMemoryExternalContext = messageEntries.some(messageHasExternalContext);
    return {
      session: {
        id: header.id,
        title: this.getSessionName() || header.title || "New Agent Session",
        provider: header.provider,
        model: header.model,
        createdAt: header.timestamp,
        updatedAt: entries.length > 0 ? entries[entries.length - 1].timestamp : header.timestamp,
        active: true,
        apiMode: null,
        reasoningEffort: null,
        leafId: this.leafId,
        memory: {
          externalContext: hasMemoryExternalContext,
        },
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
      contextUsage: this.computeContextUsage(),
      sessionStats: this.computeSessionStats(),
    };
  }

  /**
   * Compute context usage from stored assistant message metadata.
   * Uses the last assistant message's promptTokens (input tokens) as the
   * context size estimate, since input tokens = context sent to the model.
   */
  computeContextUsage(): Record<string, unknown> | null {
    const entries = this.getEntries();
    const header = this.getHeader();
    if (!header) return null;

    // Find the last assistant message with token metadata
    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i];
      if (entry.type !== "message") continue;
      const msg = entry as MessageEntry;
      if (msg.role !== "assistant" || !msg.metadata) continue;
      const meta = msg.metadata as Record<string, unknown>;
      const promptTokens = Number(meta.promptTokens ?? meta.input ?? 0);
      const totalTokens = Number(meta.totalTokens ?? 0);
      if (promptTokens <= 0 && totalTokens <= 0) continue;

      // Use promptTokens as the context window fill indicator
      const tokens = promptTokens || totalTokens;
      return { tokens, promptTokens, totalTokens };
    }
    return null;
  }

  /**
   * Compute cumulative session statistics from all stored assistant messages.
   * Matches pi's SessionStats shape.
   */
  computeSessionStats(): Record<string, unknown> {
    const entries = this.getEntries();
    const header = this.getHeader();
    const sessionId = header?.id ?? "";

    let userMessages = 0;
    let assistantMessages = 0;
    let toolCalls = 0;
    let toolResults = 0;
    let totalInput = 0;
    let totalOutput = 0;
    let totalCacheRead = 0;
    let totalCacheWrite = 0;
    let totalCost = 0;

    for (const entry of entries) {
      if (entry.type !== "message") continue;
      const msg = entry as MessageEntry;
      switch (msg.role) {
        case "user":
          userMessages++;
          break;
        case "assistant": {
          assistantMessages++;
          const meta = (msg.metadata ?? {}) as Record<string, unknown>;
          const tcs = Array.isArray(meta.toolCalls) ? meta.toolCalls : [];
          toolCalls += tcs.length;
          totalInput += Number(meta.promptTokens ?? meta.input ?? 0);
          totalOutput += Number(meta.completionTokens ?? meta.output ?? 0);
          totalCacheRead += Number(meta.cacheRead ?? 0);
          totalCacheWrite += Number(meta.cacheWrite ?? 0);
          totalCost += Number(meta.cost ?? 0);
          break;
        }
        case "toolResult":
          toolResults++;
          break;
      }
    }

    return {
      sessionId,
      userMessages,
      assistantMessages,
      toolCalls,
      toolResults,
      totalMessages: entries.filter((e) => e.type === "message").length,
      tokens: {
        input: totalInput,
        output: totalOutput,
        cacheRead: totalCacheRead,
        cacheWrite: totalCacheWrite,
        total: totalInput + totalOutput + totalCacheRead + totalCacheWrite,
      },
      cost: totalCost,
    };
  }

  // Returns a flat list of summary objects for every session on disk.
  // Used by the sidebar session list that does not need full message content.
  listSessionSummaries(): Array<Record<string, unknown>> {
    const all = SessionManager.listAll();
    return all.map((info) => ({
      id: info.id,
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
      contextUsage: null, // Computed on-demand when full session is loaded
    }));
  }
}
