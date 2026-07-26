/** 外接 CLI Runtime 共用的 Tradex Session 投影与 JSONL 持久化。 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import {
  appendRegularFileSync,
  readRegularFileSync,
  replaceRegularFileSync,
} from "../../fs/regular-file.js";
import type { ExternalAgentRuntimeId, RuntimeCapabilities } from "./types.js";

const MAX_METADATA_BYTES = 1024 * 1024;
const MAX_TRANSCRIPT_BYTES = 256 * 1024 * 1024;
const MAX_PROJECTED_ATTACHMENT_BYTES = 20 * 1024 * 1024;
const MAX_PROJECTED_ATTACHMENT_RESPONSE_BYTES = 32 * 1024 * 1024;

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
    let sessionCreated = false;
    try {
      const sessionDirectory = this.createSessionDirectory(id);
      sessionCreated = true;
      for (const directory of new Set(["attachments", ...this.extraDirectories])) {
        if (!directory || path.basename(directory) !== directory) {
          throw new Error(`invalid ${this.runtimeLabel} Session directory`);
        }
        fs.mkdirSync(path.join(sessionDirectory, directory), { mode: 0o700 });
      }
      this.writeMetadata(metadata);
      return metadata;
    } catch (error) {
      if (sessionCreated) {
        try { fs.rmSync(this.sessionDir(id), { recursive: true, force: true }); } catch { /* fail closed */ }
      }
      throw error;
    }
  }

  getMetadata(id: string): ExternalSessionMetadata<Snapshot> | null {
    try {
      const file = path.join(this.sessionDir(id), "metadata.json");
      const value = JSON.parse(readRegularFileSync(file, MAX_METADATA_BYTES).toString("utf8")) as unknown;
      return this.validateMetadata(value, id);
    } catch {
      return null;
    }
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
    appendRegularFileSync(
      path.join(this.sessionDir(id), "session.jsonl"),
      `${JSON.stringify(message)}\n`,
    );
    metadata.updatedAt = message.createdAt;
    if (input.role === "user" && metadata.title === "New Agent Session") {
      metadata.title = input.content.slice(0, 60) || metadata.title;
    }
    this.writeMetadata(metadata);
    return message;
  }

  messages(id: string): ExternalProjectedMessage[] {
    let content: string;
    try {
      content = readRegularFileSync(
        path.join(this.sessionDir(id), "session.jsonl"),
        MAX_TRANSCRIPT_BYTES,
      ).toString("utf8");
    } catch {
      return [];
    }
    return content.split("\n").filter(Boolean).flatMap((line) => {
      try { return [JSON.parse(line) as ExternalProjectedMessage]; } catch { return []; }
    });
  }

  /** Writes one attachment only inside this Session's verified attachment directory. */
  writeAttachment(id: string, extension: string, data: Buffer): string {
    if (!/^[a-z0-9]{1,10}$/i.test(extension)) throw new Error("invalid attachment extension");
    const file = path.join(this.attachmentsDirectory(id), `${crypto.randomUUID()}.${extension}`);
    fs.writeFileSync(file, data, { flag: "wx", mode: 0o600 });
    return file;
  }

  payload(id: string, options: { hydrateAttachments?: boolean } = {}): {
    session: Record<string, unknown>;
    messages: ExternalProjectedMessage[];
    contextUsage: null;
    sessionStats: Record<string, number>;
  } | null {
    const metadata = this.getMetadata(id);
    if (!metadata) return null;
    const messages = options.hydrateAttachments === false
      ? this.messages(id)
      : (() => {
          const budget = { remainingBytes: MAX_PROJECTED_ATTACHMENT_RESPONSE_BYTES };
          return this.messages(id).map((message) => this.hydrateAttachmentData(id, message, budget));
        })();
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
        const payload = this.payload(id, { hydrateAttachments: false });
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
    const target = this.sessionPath(id);
    if (!isRealChildDirectory(this.root, target)) {
      throw new Error(`invalid ${this.runtimeLabel} Session directory`);
    }
    return target;
  }

  private sessionPath(id: string): string {
    this.assertSessionId(id);
    const target = path.resolve(this.root, id);
    if (path.dirname(target) !== this.root) throw new Error(`invalid ${this.runtimeLabel} Session path`);
    return target;
  }

  private createSessionDirectory(id: string): string {
    fs.mkdirSync(this.root, { recursive: true, mode: 0o700 });
    if (!isRealDirectory(this.root)) throw new Error(`invalid ${this.runtimeLabel} Session root`);
    fs.mkdirSync(this.sessionPath(id), { mode: 0o700 });
    return this.sessionDir(id);
  }

  private attachmentsDirectory(id: string): string {
    const sessionDirectory = this.sessionDir(id);
    const attachments = path.join(sessionDirectory, "attachments");
    if (!isRealChildDirectory(sessionDirectory, attachments)) {
      throw new Error(`invalid ${this.runtimeLabel} attachment directory`);
    }
    return attachments;
  }

  private requireMetadata(id: string): ExternalSessionMetadata<Snapshot> {
    const metadata = this.getMetadata(id);
    if (!metadata) throw new Error(`${this.runtimeLabel} Session not found`);
    return metadata;
  }

  private writeMetadata(metadata: ExternalSessionMetadata<Snapshot>): void {
    const file = path.join(this.sessionDir(metadata.id), "metadata.json");
    replaceRegularFileSync(file, `${JSON.stringify(metadata, null, 2)}\n`);
  }

  /** Rehydrates UI image data from this Session's own non-symlink attachment files. */
  private hydrateAttachmentData(
    id: string,
    message: ExternalProjectedMessage,
    budget: { remainingBytes: number },
  ): ExternalProjectedMessage {
    const images = message.metadata?.images;
    if (!Array.isArray(images)) return message;
    let changed = false;
    const hydrated = images.map((image) => {
      if (!image || typeof image !== "object" || Array.isArray(image)) return image;
      const record = image as Record<string, unknown>;
      if (typeof record.data === "string" || typeof record.filename !== "string") return image;
      const result = this.readAttachment(id, record.filename, budget.remainingBytes);
      if (result === null) return image;
      changed = true;
      if (result.kind === "omitted") {
        return {
          ...record,
          dataOmitted: true,
          dataOmittedReason: "response_attachment_budget_exceeded",
        };
      }
      budget.remainingBytes -= result.bytes;
      return { ...record, data: result.data };
    });
    return changed
      ? { ...message, metadata: { ...message.metadata, images: hydrated } }
      : message;
  }

  private readAttachment(
    id: string,
    filename: string,
    remainingBytes: number,
  ): { kind: "hydrated"; data: string; bytes: number } | { kind: "omitted" } | null {
    if (!filename || path.basename(filename) !== filename) return null;
    let descriptor: number | null = null;
    try {
      const attachmentsRoot = this.attachmentsDirectory(id);
      const file = path.resolve(attachmentsRoot, filename);
      if (path.dirname(file) !== attachmentsRoot) return null;
      descriptor = fs.openSync(
        file,
        fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
      );
      const stat = fs.fstatSync(descriptor);
      if (!stat.isFile() || stat.size > MAX_PROJECTED_ATTACHMENT_BYTES) return null;
      if (stat.size > remainingBytes) return { kind: "omitted" };
      return { kind: "hydrated", data: fs.readFileSync(descriptor).toString("base64"), bytes: stat.size };
    } catch {
      return null;
    } finally {
      if (descriptor !== null) fs.closeSync(descriptor);
    }
  }

  private assertSessionId(id: string): void {
    if (!/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(id)) {
      throw new Error(`invalid ${this.runtimeLabel} Session id`);
    }
  }

  private validateMetadata(value: unknown, expectedId: string): ExternalSessionMetadata<Snapshot> {
    if (!value || typeof value !== "object") throw new Error(`invalid ${this.runtimeLabel} Session metadata`);
    const metadata = value as ExternalSessionMetadata<Snapshot>;
    this.assertSessionId(metadata.id);
    if (metadata.id !== expectedId || metadata.version !== 1 || metadata.snapshot?.runtime !== this.runtime) {
      throw new Error(`unsupported ${this.runtimeLabel} Session metadata`);
    }
    return { ...metadata, lastRun: metadata.lastRun ?? null };
  }
}

export type ExternalSessionStorePort<Runtime extends ExternalAgentRuntimeId> = Pick<
  ExternalSessionStore<Runtime, ExternalSessionSnapshot<Runtime>>,
  "getMetadata" | "sessionDir" | "beginRun" | "endRun" | "appendMessage" | "setNativeSessionId" | "writeAttachment"
>;

function isRealDirectory(directory: string): boolean {
  try {
    const stat = fs.lstatSync(directory);
    return stat.isDirectory() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}

function isRealChildDirectory(parent: string, candidate: string): boolean {
  if (path.dirname(path.resolve(candidate)) !== path.resolve(parent)
    || !isRealDirectory(parent) || !isRealDirectory(candidate)) return false;
  try {
    return path.dirname(fs.realpathSync(candidate)) === fs.realpathSync(parent);
  } catch {
    return false;
  }
}
