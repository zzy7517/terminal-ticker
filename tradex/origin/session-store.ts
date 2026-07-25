/**
 * Origin Runtime Session module.
 *
 * The registry is the source of truth for ownership and lifecycle. Runtime
 * adapters only own transcripts, so an empty Origin survives a restart and no
 * Agent/DM identity can be inferred from runtime storage.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { defaultCacheDir } from "../db.js";
import { CLAUDE_CODE_CAPABILITIES, CURSOR_CLI_CAPABILITIES, PI_SDK_CAPABILITIES } from "../agent/runtime/capabilities.js";
import {
  ExternalSessionStore,
  type ExternalSessionSnapshot,
} from "../agent/runtime/external-session-store.js";
import {
  createPiSession,
  deletePiSession,
  openPiSession,
  piProviderName,
  piSessionPayload,
} from "../agent/runtime/pi/sessions.js";

export const ORIGIN_SNAPSHOT_ENTRY = "tradex_origin_snapshot";
export type OriginRuntimeId = "pi" | "claude-code" | "cursor";

interface OriginOwner { kind: "origin" }

export type OriginRuntimeSnapshot =
  | {
      owner: OriginOwner;
      runtime: "pi";
      systemPrompt: string;
      provider: string;
      model: string;
      reasoningEffort: string;
    }
  | (ExternalSessionSnapshot<"claude-code"> & { owner: OriginOwner })
  | (ExternalSessionSnapshot<"cursor"> & { owner: OriginOwner });

export interface CreateOriginInput {
  title?: string;
  runtime: OriginRuntimeId;
  systemPrompt?: string;
  provider?: string | null;
  model?: string | null;
  reasoningEffort?: string | null;
  workspace?: string;
}

export interface OriginSessionDto {
  id: string;
  title: string;
  owner: OriginOwner;
  runtime: OriginRuntimeId;
  provider: string | null;
  model: string;
  reasoningEffort: string | null;
  workspace: string;
  systemPrompt: string;
  createdAt: string;
  updatedAt: string;
  capabilities: typeof PI_SDK_CAPABILITIES;
}

export interface OriginMessageDto {
  id: string | number;
  sessionId: string;
  role: "user" | "assistant" | "system" | "toolResult";
  content: string;
  createdAt: string;
  metadata: Record<string, unknown> | null;
  error: string | null;
}

export interface OriginRunDto {
  sessionId: string;
  runId: string | null;
  status: "idle" | "running" | "error";
  activeFlags: string[];
  lastSeq: number;
  error: string | null;
}

export interface OriginSessionResponseDto {
  session: OriginSessionDto | null;
  messages: OriginMessageDto[];
  contextUsage?: unknown;
  sessionStats?: Record<string, unknown>;
  run: OriginRunDto;
}

export interface OriginSessionSummaryDto extends OriginSessionDto {
  messageCount: number;
  preview: string;
  run: OriginRunDto;
}

export interface OriginHistoryDto { sessions: OriginSessionSummaryDto[] }

interface OriginMetadata {
  version: 1;
  id: string;
  title: string;
  workspace: string;
  createdAt: string;
  updatedAt: string;
  snapshot: OriginRuntimeSnapshot;
}

type ClaudeOriginSnapshot = Extract<OriginRuntimeSnapshot, { runtime: "claude-code" }>;
type CursorOriginSnapshot = Extract<OriginRuntimeSnapshot, { runtime: "cursor" }>;

export class OriginSessionStore {
  readonly root: string;
  readonly claudeSessions: ExternalSessionStore<"claude-code", ClaudeOriginSnapshot>;
  readonly cursorSessions: ExternalSessionStore<"cursor", CursorOriginSnapshot>;
  private readonly registryRoot: string;
  private readonly piRoot: string;
  private readonly pendingPi = new Map<string, SessionManager>();

  constructor(root = path.join(defaultCacheDir(), "origin_sessions")) {
    this.root = path.resolve(root);
    this.registryRoot = path.join(this.root, "registry");
    this.piRoot = path.join(this.root, "pi");
    this.claudeSessions = new ExternalSessionStore({
      root: path.join(this.root, "claude-code"), runtime: "claude-code",
      runtimeLabel: "Origin Claude", capabilities: CLAUDE_CODE_CAPABILITIES,
    });
    this.cursorSessions = new ExternalSessionStore({
      root: path.join(this.root, "cursor"), runtime: "cursor",
      runtimeLabel: "Origin Cursor", capabilities: CURSOR_CLI_CAPABILITIES,
      extraDirectories: [".cursor"],
    });
  }

  create(input: CreateOriginInput): { id: string; snapshot: OriginRuntimeSnapshot; manager?: SessionManager } {
    const workspace = resolveWorkspace(input.workspace);
    const snapshot = buildSnapshot(input);
    const title = input.title?.trim() || "New Origin";
    let id: string;
    let manager: SessionManager | undefined;
    if (snapshot.runtime === "pi") {
      manager = createPiSession({ title, cwd: workspace, sessionDir: this.piRoot });
      manager.appendCustomEntry(ORIGIN_SNAPSHOT_ENTRY, snapshot);
      manager.appendModelChange(piProviderName(snapshot.provider), snapshot.model);
      manager.appendThinkingLevelChange(snapshot.reasoningEffort);
      id = manager.getSessionId();
      materializePiSession(manager);
      manager = SessionManager.open(manager.getSessionFile()!, this.piRoot, workspace);
      this.pendingPi.set(id, manager);
    } else if (snapshot.runtime === "claude-code") {
      id = this.claudeSessions.create({ title, snapshot }).id;
    } else {
      id = this.cursorSessions.create({ title, snapshot }).id;
    }
    const now = new Date().toISOString();
    this.writeMetadata({ version: 1, id, title, workspace, createdAt: now, updatedAt: now, snapshot });
    return { id, snapshot, manager };
  }

  owns(id: string): boolean { return this.getMetadata(id) !== null; }

  getMetadata(id: string): OriginMetadata | null {
    if (!validId(id)) return null;
    const file = this.metadataFile(id);
    if (!fs.existsSync(file)) return null;
    try { return validateMetadata(JSON.parse(fs.readFileSync(file, "utf8"))); } catch { return null; }
  }

  async openPi(id: string): Promise<SessionManager | null> {
    const metadata = this.getMetadata(id);
    if (!metadata || metadata.snapshot.runtime !== "pi") return null;
    return this.pendingPi.get(id) ?? openPiSession(id, this.piRoot, metadata.workspace);
  }

  async response(id: string, running = false): Promise<OriginSessionResponseDto> {
    const metadata = this.getMetadata(id);
    if (!metadata) return { session: null, messages: [], run: idleRun(id) };
    const raw = await this.runtimePayload(metadata);
    if (!raw) return { session: null, messages: [], run: idleRun(id) };
    const messages = normalizeMessages(raw.messages);
    const derivedTitle = metadata.title === "New Origin"
      ? firstUserTitle(messages) || metadata.title
      : metadata.title;
    if (derivedTitle !== metadata.title) {
      metadata.title = derivedTitle;
      metadata.updatedAt = new Date().toISOString();
      this.writeMetadata(metadata);
    }
    return {
      session: projectSession(metadata, raw.session),
      messages,
      contextUsage: raw.contextUsage,
      sessionStats: raw.sessionStats,
      run: running ? { ...idleRun(id), status: "running" } : idleRun(id),
    };
  }

  async history(runningIds: ReadonlySet<string>): Promise<OriginHistoryDto> {
    const metadata = this.listMetadata();
    const sessions = await Promise.all(metadata.map(async (item): Promise<OriginSessionSummaryDto | null> => {
      const response = await this.response(item.id, runningIds.has(item.id));
      if (!response.session) return null;
      const first = response.messages.find((message) => message.role === "user");
      return {
        ...response.session,
        messageCount: response.messages.length,
        preview: first?.content || "(no messages)",
        run: response.run,
      };
    }));
    return {
      sessions: sessions.filter((item): item is OriginSessionSummaryDto => !!item)
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 200),
    };
  }

  async remove(id: string): Promise<boolean> {
    const metadata = this.getMetadata(id);
    if (!metadata) return false;
    this.pendingPi.delete(id);
    if (metadata.snapshot.runtime === "pi") await deletePiSession(id, this.piRoot);
    else if (metadata.snapshot.runtime === "claude-code") this.claudeSessions.removeFiles(id);
    else this.cursorSessions.removeFiles(id);
    fs.rmSync(this.metadataFile(id), { force: true });
    return true;
  }

  release(manager: SessionManager): void { this.pendingPi.delete(manager.getSessionId()); }

  private async runtimePayload(metadata: OriginMetadata): Promise<{
    session: Record<string, unknown>; messages: unknown[]; contextUsage?: unknown; sessionStats?: Record<string, unknown>;
  } | null> {
    if (metadata.snapshot.runtime === "pi") {
      const manager = await this.openPi(metadata.id);
      if (!manager) return null;
      const payload = piSessionPayload(manager);
      return {
        session: payload.session as Record<string, unknown>,
        messages: Array.isArray(payload.messages) ? payload.messages : [],
        contextUsage: payload.contextUsage,
        sessionStats: payload.sessionStats as Record<string, unknown> | undefined,
      };
    }
    const payload = metadata.snapshot.runtime === "claude-code"
      ? this.claudeSessions.payload(metadata.id)
      : this.cursorSessions.payload(metadata.id);
    return payload ? { ...payload, messages: payload.messages } : null;
  }

  private listMetadata(): OriginMetadata[] {
    if (!fs.existsSync(this.registryRoot)) return [];
    return fs.readdirSync(this.registryRoot).filter((name) => name.endsWith(".json"))
      .flatMap((name) => {
        const id = name.slice(0, -5);
        const metadata = this.getMetadata(id);
        return metadata ? [metadata] : [];
      });
  }

  private metadataFile(id: string): string { return path.join(this.registryRoot, `${id}.json`); }

  private writeMetadata(metadata: OriginMetadata): void {
    fs.mkdirSync(this.registryRoot, { recursive: true, mode: 0o700 });
    const file = this.metadataFile(metadata.id);
    const temp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
    fs.writeFileSync(temp, `${JSON.stringify(metadata, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temp, file);
  }
}

function buildSnapshot(input: CreateOriginInput): OriginRuntimeSnapshot {
  const common = { owner: { kind: "origin" } as const, systemPrompt: input.systemPrompt?.trim() ?? "" };
  if (input.runtime === "pi") {
    const provider = input.provider?.trim() ?? "";
    const model = input.model?.trim() ?? "";
    if (!provider || !model) throw new Error("Pi Origin requires provider and model");
    return { ...common, runtime: "pi", provider, model, reasoningEffort: input.reasoningEffort?.trim() ?? "" };
  }
  return {
    ...common,
    runtime: input.runtime,
    provider: null,
    model: input.model?.trim() || null,
    reasoningEffort: input.runtime === "claude-code" ? input.reasoningEffort?.trim() || null : null,
  } as OriginRuntimeSnapshot;
}

function resolveWorkspace(value?: string): string {
  const workspace = path.resolve(value?.trim() || process.cwd());
  if (!fs.existsSync(workspace) || !fs.statSync(workspace).isDirectory()) throw new Error("Origin workspace must be an existing directory");
  return workspace;
}

function materializePiSession(manager: SessionManager): void {
  const file = manager.getSessionFile();
  const header = manager.getHeader();
  if (!file || !header) throw new Error("Pi Origin could not allocate persistent storage");
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const entries = [header, ...manager.getEntries()];
  fs.writeFileSync(file, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`, { mode: 0o600 });
}

function projectSession(metadata: OriginMetadata, raw: Record<string, unknown>): OriginSessionDto {
  const capabilities = metadata.snapshot.runtime === "pi" ? PI_SDK_CAPABILITIES
    : metadata.snapshot.runtime === "claude-code" ? CLAUDE_CODE_CAPABILITIES : CURSOR_CLI_CAPABILITIES;
  return {
    id: metadata.id,
    title: metadata.title,
    owner: { kind: "origin" },
    runtime: metadata.snapshot.runtime,
    provider: metadata.snapshot.provider,
    model: metadata.snapshot.model ?? "",
    reasoningEffort: metadata.snapshot.reasoningEffort || null,
    workspace: metadata.workspace,
    systemPrompt: metadata.snapshot.systemPrompt,
    createdAt: metadata.createdAt,
    updatedAt: typeof raw.updatedAt === "string" && raw.updatedAt > metadata.updatedAt ? raw.updatedAt : metadata.updatedAt,
    capabilities,
  };
}

function normalizeMessages(value: unknown): OriginMessageDto[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is OriginMessageDto => !!item && typeof item === "object"
    && typeof (item as OriginMessageDto).sessionId === "string"
    && typeof (item as OriginMessageDto).content === "string");
}

function firstUserTitle(messages: OriginMessageDto[]): string {
  return messages.find((item) => item.role === "user")?.content.trim().replace(/[\n\r]+/g, " ").slice(0, 60) ?? "";
}

function idleRun(id: string): OriginRunDto {
  return { sessionId: id, runId: null, status: "idle", activeFlags: [], lastSeq: 0, error: null };
}

function validId(id: string): boolean { return /^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(id); }

function validateMetadata(value: unknown): OriginMetadata {
  if (!value || typeof value !== "object") throw new Error("invalid Origin metadata");
  const metadata = value as OriginMetadata;
  if (metadata.version !== 1 || !validId(metadata.id) || metadata.snapshot?.owner?.kind !== "origin") {
    throw new Error("unsupported Origin metadata");
  }
  if (!["pi", "claude-code", "cursor"].includes(metadata.snapshot.runtime)) throw new Error("invalid Origin runtime");
  return metadata;
}
