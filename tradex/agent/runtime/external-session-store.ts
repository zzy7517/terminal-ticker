/** 外接 CLI Runtime 共用的 Tradex Session 投影与 JSONL 持久化。 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type { ExternalAgentRuntimeId, RuntimeCapabilities } from "./types.js";

export interface ExternalSessionSnapshot<Runtime extends ExternalAgentRuntimeId> {
  runtime: Runtime;
  systemPrompt: string;
  provider: null;
  model: string | null;
  reasoningEffort: string | null;
}

export interface ExternalAgentSnapshot<Runtime extends ExternalAgentRuntimeId>
  extends ExternalSessionSnapshot<Runtime> {
  agentId: string;
  agentName: string;
}

export interface ExternalProjectedMessage {
  id: string;
  sessionId: string;
  role: "user" | "assistant" | "toolResult";
  content: string;
  createdAt: string;
  metadata: Record<string, unknown> | null;
  error: string | null;
}

export interface ExternalSessionMetadata<Snapshot> {
  version: 1;
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  nativeSessionId: string | null;
  snapshot: Snapshot;
  lastRun: {
    status: "running" | "completed" | "error" | "cancelled";
    startedAt: string;
    endedAt: string | null;
    error: string | null;
  } | null;
}

interface ExternalSessionStoreOptions<Runtime extends ExternalAgentRuntimeId> {
  root: string;
  runtime: Runtime;
  runtimeLabel: string;
  capabilities: RuntimeCapabilities;
  extraDirectories?: string[];
}

export class ExternalSessionStore<
  Runtime extends ExternalAgentRuntimeId,
  Snapshot extends ExternalSessionSnapshot<Runtime>,
> {
  readonly root: string;
  private readonly runtime: Runtime;
  private readonly runtimeLabel: string;
  private readonly capabilities: RuntimeCapabilities;
  private readonly extraDirectories: string[];

  constructor(options: ExternalSessionStoreOptions<Runtime>) {
    this.root = path.resolve(options.root);
    this.runtime = options.runtime;
    this.runtimeLabel = options.runtimeLabel;
    this.capabilities = options.capabilities;
    this.extraDirectories = options.extraDirectories ?? [];
  }

  create(input: { title: string; snapshot: Snapshot }): ExternalSessionMetadata<Snapshot> {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const metadata: ExternalSessionMetadata<Snapshot> = {
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
    for (const directory of ["attachments", ...this.extraDirectories]) {
      fs.mkdirSync(path.join(this.sessionDir(id), directory), { recursive: true, mode: 0o700 });
    }
    this.writeMetadata(metadata);
    return metadata;
  }

  getMetadata(id: string): ExternalSessionMetadata<Snapshot> | null {
    const file = path.join(this.sessionDir(id), "metadata.json");
    if (!fs.existsSync(file)) return null;
    return this.validateMetadata(JSON.parse(fs.readFileSync(file, "utf8")) as unknown);
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

  appendMessage(id: string, input: {
    role: ExternalProjectedMessage["role"];
    content: string;
    metadata?: Record<string, unknown> | null;
    error?: string | null;
  }): ExternalProjectedMessage {
    const metadata = this.requireMetadata(id);
    const message: ExternalProjectedMessage = {
      id: `${input.role}:${crypto.randomUUID()}`,
      sessionId: id,
      role: input.role,
      content: input.content,
      createdAt: new Date().toISOString(),
      metadata: input.metadata ?? null,
      error: input.error ?? null,
    };
    fs.appendFileSync(path.join(this.sessionDir(id), "session.jsonl"), `${JSON.stringify(message)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    metadata.updatedAt = message.createdAt;
    if (input.role === "user" && metadata.title === "New Agent Session") {
      metadata.title = input.content.slice(0, 60) || metadata.title;
    }
    this.writeMetadata(metadata);
    return message;
  }

  messages(id: string): ExternalProjectedMessage[] {
    const file = path.join(this.sessionDir(id), "session.jsonl");
    if (!fs.existsSync(file)) return [];
    return fs.readFileSync(file, "utf8").split("\n").filter(Boolean).flatMap((line) => {
      try { return [JSON.parse(line) as ExternalProjectedMessage]; } catch { return []; }
    });
  }

  payload(id: string): {
    session: Record<string, unknown>;
    messages: ExternalProjectedMessage[];
    contextUsage: null;
    sessionStats: Record<string, number>;
  } | null {
    const metadata = this.getMetadata(id);
    if (!metadata) return null;
    const messages = this.messages(id);
    return {
      session: {
        id,
        title: metadata.title,
        runtime: this.runtime,
        capabilities: this.capabilities,
        nativeSessionId: metadata.nativeSessionId,
        provider: null,
        model: metadata.snapshot.model ?? "",
        reasoningEffort: metadata.snapshot.reasoningEffort,
        createdAt: metadata.createdAt,
        updatedAt: metadata.updatedAt,
        active: true,
        apiMode: null,
        ...("agentId" in metadata.snapshot && typeof metadata.snapshot.agentId === "string"
          ? {
              agentId: metadata.snapshot.agentId,
              agentName: "agentName" in metadata.snapshot ? metadata.snapshot.agentName : metadata.snapshot.agentId,
            }
          : {}),
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
        if (!payload) return [];
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
      try {
        const snapshot = this.getMetadata(id)?.snapshot;
        return !!snapshot && "agentId" in snapshot && snapshot.agentId === agentId;
      } catch { return false; }
    });
  }

  removeFiles(id: string): void {
    fs.rmSync(this.sessionDir(id), { recursive: true, force: true });
  }

  sessionDir(id: string): string {
    this.assertSessionId(id);
    const target = path.resolve(this.root, id);
    if (path.dirname(target) !== this.root) throw new Error(`invalid ${this.runtimeLabel} Session path`);
    return target;
  }

  private requireMetadata(id: string): ExternalSessionMetadata<Snapshot> {
    const metadata = this.getMetadata(id);
    if (!metadata) throw new Error(`${this.runtimeLabel} Session not found`);
    return metadata;
  }

  private writeMetadata(metadata: ExternalSessionMetadata<Snapshot>): void {
    const file = path.join(this.sessionDir(metadata.id), "metadata.json");
    const temp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temp, `${JSON.stringify(metadata, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    fs.renameSync(temp, file);
  }

  private assertSessionId(id: string): void {
    if (!/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(id)) {
      throw new Error(`invalid ${this.runtimeLabel} Session id`);
    }
  }

  private validateMetadata(value: unknown): ExternalSessionMetadata<Snapshot> {
    if (!value || typeof value !== "object") throw new Error(`invalid ${this.runtimeLabel} Session metadata`);
    const metadata = value as ExternalSessionMetadata<Snapshot>;
    this.assertSessionId(metadata.id);
    if (metadata.version !== 1 || metadata.snapshot?.runtime !== this.runtime) {
      throw new Error(`unsupported ${this.runtimeLabel} Session metadata`);
    }
    return { ...metadata, lastRun: metadata.lastRun ?? null };
  }
}

export type ExternalSessionStorePort<Runtime extends ExternalAgentRuntimeId> = Pick<
  ExternalSessionStore<Runtime, ExternalSessionSnapshot<Runtime>>,
  "getMetadata" | "sessionDir" | "beginRun" | "endRun" | "appendMessage" | "setNativeSessionId"
>;
