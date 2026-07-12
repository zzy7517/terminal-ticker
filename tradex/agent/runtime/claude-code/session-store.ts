/** 保存 Claude Session 的 Tradex 投影、消息历史和 native session ID。 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { CLAUDE_CODE_CAPABILITIES } from "../capabilities.js";

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

  /** 使用用户目录下的 Claude Session 根目录初始化存储。 */
  constructor(root = path.join(os.homedir(), ".tradex", "claude_sessions")) {
    this.root = path.resolve(root);
  }

  /** 创建一个新的 Tradex projection、metadata 和附件目录。 */
  create(input: { title: string; snapshot: ClaudeAgentSnapshot }): ClaudeSessionMetadata {
    // Tradex Session ID 只服务于 UI/API；Claude native session ID 单独记录，二者不能混用。
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

  /** 读取并校验指定 Session 的 metadata。 */
  getMetadata(id: string): ClaudeSessionMetadata | null {
    const file = path.join(this.sessionDir(id), "metadata.json");
    if (!fs.existsSync(file)) return null;
    return validateMetadata(JSON.parse(fs.readFileSync(file, "utf8")) as unknown);
  }

  /** 原子更新 Claude native session ID，供下一轮 resume 使用。 */
  setNativeSessionId(id: string, nativeSessionId: string): void {
    const metadata = this.requireMetadata(id);
    metadata.nativeSessionId = nativeSessionId;
    metadata.updatedAt = new Date().toISOString();
    this.writeMetadata(metadata);
  }

  /** 记录一次 Claude run 开始，并把 Session 标记为运行中。 */
  beginRun(id: string): void {
    const metadata = this.requireMetadata(id);
    const now = new Date().toISOString();
    metadata.lastRun = { status: "running", startedAt: now, endedAt: null, error: null };
    metadata.updatedAt = now;
    this.writeMetadata(metadata);
  }

  /** 记录一次 Claude run 的结束状态、时间和错误信息。 */
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

  /** 向 Tradex projection 追加一条用户、助手或工具结果消息。 */
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
    };
    fs.appendFileSync(path.join(this.sessionDir(id), "session.jsonl"), `${JSON.stringify(message)}\n`, { encoding: "utf8", mode: 0o600 });
    metadata.updatedAt = message.createdAt;
    if (input.role === "user" && metadata.title === "New Agent Session") metadata.title = input.content.slice(0, 60) || metadata.title;
    this.writeMetadata(metadata);
    return message;
  }

  /** 读取 Session 的 JSONL projection，忽略无法解析的损坏行。 */
  messages(id: string): ClaudeProjectedMessage[] {
    // projection 是 UI 历史来源，不用于重新拼接 prompt；下一轮上下文交给 Claude 原生 resume。
    const file = path.join(this.sessionDir(id), "session.jsonl");
    if (!fs.existsSync(file)) return [];
    return fs.readFileSync(file, "utf8").split("\n").filter(Boolean).flatMap((line) => {
      try { return [JSON.parse(line) as ClaudeProjectedMessage]; } catch { return []; }
    });
  }

  /** 组装单 Session API 所需的统一 DTO。 */
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
        memory: { externalContext: false },
        lastRun: metadata.lastRun,
      },
      messages,
      contextUsage: null,
      sessionStats: { totalMessages: messages.length },
    };
  }

  /** 扫描并返回有消息的 Claude Session 摘要。 */
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

  /** 判断某个 Agent 是否仍被 Claude projection 引用。 */
  hasPersistedSessionForAgent(agentId: string): boolean {
    if (!fs.existsSync(this.root)) return false;
    return fs.readdirSync(this.root).some((id) => {
      try { return this.getMetadata(id)?.snapshot.agentId === agentId; } catch { return false; }
    });
  }

  /** 删除本地 projection、metadata、附件和运行目录。 */
  removeFiles(id: string): void {
    // 调用方会先完成 Claude project purge，再删除本地 projection，避免出现部分删除。
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
