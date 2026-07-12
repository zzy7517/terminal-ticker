import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { CLAUDE_CODE_CAPABILITIES } from "./runtime/claude-code.js";

export interface ClaudeAgentSnapshot {
  agentId: string;
  agentName: string;
  runtime: "claude-code";
  systemPrompt: string;
  provider: null;
  model: string | null;
  reasoningEffort: string | null;
}

export interface ClaudeProjectedMessage {
  id: string;
  sessionId: string;
  role: "user" | "assistant" | "toolResult";
  content: string;
  createdAt: string;
  metadata: Record<string, unknown> | null;
  error: string | null;
  entryId: string;
  parentId: null;
  entryType: "message";
}

interface ClaudeSessionMetadata {
  version: 1;
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  nativeSessionId: string | null;
  snapshot: ClaudeAgentSnapshot;
  lastRun: {
    status: "running" | "completed" | "error" | "cancelled";
    startedAt: string;
    endedAt: string | null;
    error: string | null;
  } | null;
}

export class ClaudeSessionStore {
  readonly root: string;

  constructor(root = path.join(os.homedir(), ".tradex", "claude_sessions")) {
    this.root = path.resolve(root);
  }

  create(input: { title: string; snapshot: ClaudeAgentSnapshot }): ClaudeSessionMetadata {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const metadata: ClaudeSessionMetadata = {
      version: 1,
      id,
      title: input.title.trim() || "New Agent Session",
      createdAt: now,
      updatedAt: now,
      nativeSessionId: null,
      snapshot: input.snapshot,
      lastRun: null,
    };
    fs.mkdirSync(this.sessionDir(id), { recursive: true, mode: 0o700 });
    fs.mkdirSync(path.join(this.sessionDir(id), "attachments"), { recursive: true, mode: 0o700 });
    this.writeMetadata(metadata);
    return metadata;
  }

  getMetadata(id: string): ClaudeSessionMetadata | null {
    const file = path.join(this.sessionDir(id), "metadata.json");
    if (!fs.existsSync(file)) return null;
    return validateMetadata(JSON.parse(fs.readFileSync(file, "utf8")) as unknown);
  }

  setNativeSessionId(id: string, nativeSessionId: string): void {
    const metadata = this.requireMetadata(id);
    metadata.nativeSessionId = nativeSessionId;
    metadata.updatedAt = new Date().toISOString();
    this.writeMetadata(metadata);
  }

  beginRun(id: string): void {
    const metadata = this.requireMetadata(id);
    const now = new Date().toISOString();
    metadata.lastRun = { status: "running", startedAt: now, endedAt: null, error: null };
    metadata.updatedAt = now;
    this.writeMetadata(metadata);
  }

  endRun(id: string, input: { status: "completed" | "error" | "cancelled"; error?: string | null }): void {
    const metadata = this.requireMetadata(id);
    const endedAt = new Date().toISOString();
    metadata.lastRun = {
      status: input.status,
      startedAt: metadata.lastRun?.startedAt ?? endedAt,
      endedAt,
      error: input.error ?? null,
    };
    metadata.updatedAt = endedAt;
    this.writeMetadata(metadata);
  }

  appendMessage(id: string, input: { role: ClaudeProjectedMessage["role"]; content: string; metadata?: Record<string, unknown> | null; error?: string | null }): ClaudeProjectedMessage {
    const metadata = this.requireMetadata(id);
    const message: ClaudeProjectedMessage = {
      id: `${input.role}:${crypto.randomUUID()}`,
      sessionId: id,
      role: input.role,
      content: input.content,
      createdAt: new Date().toISOString(),
      metadata: input.metadata ?? null,
      error: input.error ?? null,
      entryId: crypto.randomUUID(),
      parentId: null,
      entryType: "message",
    };
    fs.appendFileSync(path.join(this.sessionDir(id), "session.jsonl"), `${JSON.stringify(message)}\n`, { encoding: "utf8", mode: 0o600 });
    metadata.updatedAt = message.createdAt;
    if (input.role === "user" && metadata.title === "New Agent Session") metadata.title = input.content.slice(0, 60) || metadata.title;
    this.writeMetadata(metadata);
    return message;
  }

  messages(id: string): ClaudeProjectedMessage[] {
    const file = path.join(this.sessionDir(id), "session.jsonl");
    if (!fs.existsSync(file)) return [];
    return fs.readFileSync(file, "utf8").split("\n").filter(Boolean).flatMap((line) => {
      try { return [JSON.parse(line) as ClaudeProjectedMessage]; } catch { return []; }
    });
  }

  payload(id: string): { session: Record<string, unknown>; messages: ClaudeProjectedMessage[]; contextUsage: null; sessionStats: Record<string, number> } | null {
    const metadata = this.getMetadata(id);
    if (!metadata) return null;
    const messages = this.messages(id);
    return {
      session: {
        id,
        title: metadata.title,
        runtime: "claude-code",
        capabilities: CLAUDE_CODE_CAPABILITIES,
        nativeSessionId: metadata.nativeSessionId,
        provider: null,
        model: metadata.snapshot.model ?? "",
        reasoningEffort: metadata.snapshot.reasoningEffort,
        createdAt: metadata.createdAt,
        updatedAt: metadata.updatedAt,
        active: true,
        apiMode: null,
        agentId: metadata.snapshot.agentId,
        agentName: metadata.snapshot.agentName,
        leafId: null,
        memory: { externalContext: false },
        lastRun: metadata.lastRun,
      },
      messages,
      contextUsage: null,
      sessionStats: { totalMessages: messages.length },
    };
  }

  list(): Array<Record<string, unknown>> {
    if (!fs.existsSync(this.root)) return [];
    return fs.readdirSync(this.root).flatMap((id) => {
      try {
        const payload = this.payload(id);
        if (!payload || payload.messages.length === 0) return [];
        const first = payload.messages.find((message) => message.role === "user");
        return [{
          ...payload.session,
          active: false,
          messageCount: payload.messages.length,
          preview: first?.content ?? "(no messages)",
          contextUsage: null,
        } as Record<string, unknown>];
      } catch { return []; }
    }).sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)));
  }

  hasPersistedSessionForAgent(agentId: string): boolean {
    if (!fs.existsSync(this.root)) return false;
    return fs.readdirSync(this.root).some((id) => {
      try { return this.getMetadata(id)?.snapshot.agentId === agentId; } catch { return false; }
    });
  }

  removeFiles(id: string): void {
    fs.rmSync(this.sessionDir(id), { recursive: true, force: true });
  }

  sessionDir(id: string): string {
    assertSessionId(id);
    const target = path.resolve(this.root, id);
    if (path.dirname(target) !== this.root) throw new Error("invalid Claude Session path");
    return target;
  }

  private requireMetadata(id: string): ClaudeSessionMetadata {
    const metadata = this.getMetadata(id);
    if (!metadata) throw new Error("Claude Session not found");
    return metadata;
  }

  private writeMetadata(metadata: ClaudeSessionMetadata): void {
    const file = path.join(this.sessionDir(metadata.id), "metadata.json");
    const temp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temp, `${JSON.stringify(metadata, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    fs.renameSync(temp, file);
  }
}

function assertSessionId(id: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(id)) throw new Error("invalid Claude Session id");
}

function validateMetadata(value: unknown): ClaudeSessionMetadata {
  if (!value || typeof value !== "object") throw new Error("invalid Claude Session metadata");
  const metadata = value as ClaudeSessionMetadata;
  assertSessionId(metadata.id);
  if (metadata.version !== 1 || metadata.snapshot?.runtime !== "claude-code") throw new Error("unsupported Claude Session metadata");
  return { ...metadata, lastRun: metadata.lastRun ?? null };
}
