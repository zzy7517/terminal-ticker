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
import { readRegularFileSync, replaceRegularFileSync } from "../fs/regular-file.js";

export const ORIGIN_SNAPSHOT_ENTRY = "tradex_origin_snapshot";
const ORIGIN_WORKSPACE_OWNER_FILE = ".tradex-origin-owner.json";
const MAX_ORIGIN_METADATA_BYTES = 1024 * 1024;
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
  materializationId?: string;
  runtime: OriginRuntimeId;
  systemPrompt?: string;
  provider?: string | null;
  model?: string | null;
  reasoningEffort?: string | null;
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

export interface OriginDeletionTarget {
  runtime: OriginRuntimeId;
  workspace: string;
  ownsWorkspace: boolean;
}

interface OriginMetadata {
  version: 1;
  id: string;
  title: string;
  materializationId: string | null;
  workspace: string;
  workspaceOwned: boolean;
  createdAt: string;
  updatedAt: string;
  snapshot: OriginRuntimeSnapshot;
}

type ClaudeOriginSnapshot = Extract<OriginRuntimeSnapshot, { runtime: "claude-code" }>;
type CursorOriginSnapshot = Extract<OriginRuntimeSnapshot, { runtime: "cursor" }>;

export class OriginMaterializationConflictError extends Error {
  constructor(readonly sessionId: string) {
    super("Origin was already materialized");
    this.name = "OriginMaterializationConflictError";
  }
}

export class OriginSessionStore {
  readonly root: string;
  readonly claudeSessions: ExternalSessionStore<"claude-code", ClaudeOriginSnapshot>;
  readonly cursorSessions: ExternalSessionStore<"cursor", CursorOriginSnapshot>;
  private readonly registryRoot: string;
  private readonly piRoot: string;
  private readonly workspacesRoot: string;
  private readonly pendingPi = new Map<string, SessionManager>();

  constructor(root = path.join(defaultCacheDir(), "origin_sessions")) {
    this.root = path.resolve(root);
    this.registryRoot = path.join(this.root, "registry");
    this.piRoot = path.join(this.root, "pi");
    this.workspacesRoot = path.join(this.root, "workspaces");
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
    const materializationId = normalizeMaterializationId(input.materializationId);
    if (materializationId) {
      const existing = this.sessionIdForMaterialization(materializationId);
      if (existing) throw new OriginMaterializationConflictError(existing);
    }
    const snapshot = buildSnapshot(input);
    const workspaceOwned = true;
    const workspace = this.createWorkspace();
    const title = input.title?.trim() || "New Origin";
    let id: string | null = null;
    let manager: SessionManager | undefined;
    try {
      if (snapshot.runtime === "pi") {
        manager = createPiSession({ title, cwd: workspace, sessionDir: this.piRoot });
        id = manager.getSessionId();
        manager.appendCustomEntry(ORIGIN_SNAPSHOT_ENTRY, snapshot);
        manager.appendModelChange(piProviderName(snapshot.provider), snapshot.model);
        manager.appendThinkingLevelChange(snapshot.reasoningEffort);
        materializePiSession(manager);
        manager = SessionManager.open(manager.getSessionFile()!, this.piRoot, workspace);
        this.pendingPi.set(id, manager);
      } else if (snapshot.runtime === "claude-code") {
        id = this.claudeSessions.create({ title, snapshot }).id;
      } else {
        id = this.cursorSessions.create({ title, snapshot }).id;
      }
      this.writeWorkspaceOwner(workspace, id);
      const now = new Date().toISOString();
      this.writeMetadata({
        version: 1,
        id,
        title,
        materializationId,
        workspace,
        workspaceOwned,
        createdAt: now,
        updatedAt: now,
        snapshot,
      });
      return { id, snapshot, manager };
    } catch (error) {
      if (id) {
        this.pendingPi.delete(id);
        fs.rmSync(this.metadataFile(id), { force: true });
        if (snapshot.runtime === "pi") {
          const sessionFile = manager?.getSessionFile();
          if (sessionFile && isWithin(this.piRoot, sessionFile)) fs.rmSync(sessionFile, { force: true });
        } else if (snapshot.runtime === "claude-code") {
          this.claudeSessions.removeFiles(id);
        } else {
          this.cursorSessions.removeFiles(id);
        }
      }
      if (workspaceOwned) {
        if (id) this.removeWorkspaceIfOwned(workspace, id);
        this.removeWorkspaceIfOwned(workspace, null);
      }
      throw error;
    }
  }

  owns(id: string): boolean { return this.getMetadata(id) !== null; }

  run(id: string, running = false): OriginRunDto | null {
    if (!this.getMetadata(id)) return null;
    return running ? { ...idleRun(id), status: "running" } : idleRun(id);
  }

  getMetadata(id: string): OriginMetadata | null {
    if (!validId(id)) return null;
    const file = this.metadataFile(id);
    try {
      const metadata = validateMetadata(JSON.parse(
        readRegularFileSync(file, MAX_ORIGIN_METADATA_BYTES).toString("utf8"),
      ));
      return metadata.id === id ? metadata : null;
    } catch {
      return null;
    }
  }

  deletionTarget(id: string): OriginDeletionTarget | null {
    const metadata = this.getMetadata(id);
    return metadata ? deletionTarget(metadata, this.workspacesRoot, id) : null;
  }

  sessionIdForMaterialization(materializationId: string): string | null {
    const normalized = normalizeMaterializationId(materializationId);
    if (!normalized) return null;
    return this.listMetadata().find((metadata) => metadata.materializationId === normalized)?.id ?? null;
  }

  async openPi(id: string): Promise<SessionManager | null> {
    const metadata = this.getMetadata(id);
    if (!metadata || metadata.snapshot.runtime !== "pi") return null;
    return this.pendingPi.get(id) ?? openPiSession(id, this.piRoot, metadata.workspace);
  }

  async response(id: string, running = false, hydrateAttachments = true): Promise<OriginSessionResponseDto> {
    const metadata = this.getMetadata(id);
    if (!metadata) return { session: null, messages: [], run: idleRun(id) };
    const raw = await this.runtimePayload(metadata, hydrateAttachments);
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
      const response = await this.response(item.id, runningIds.has(item.id), false);
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
    const target = deletionTarget(metadata, this.workspacesRoot, id);
    this.pendingPi.delete(id);
    if (metadata.snapshot.runtime === "pi") await deletePiSession(id, this.piRoot);
    else if (metadata.snapshot.runtime === "claude-code") this.claudeSessions.removeFiles(id);
    else this.cursorSessions.removeFiles(id);
    if (target.ownsWorkspace) this.removeWorkspaceIfOwned(target.workspace, id);
    fs.rmSync(this.metadataFile(id), { force: true });
    return true;
  }

  release(manager: SessionManager): void { this.pendingPi.delete(manager.getSessionId()); }

  private async runtimePayload(metadata: OriginMetadata, hydrateAttachments: boolean): Promise<{
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
      ? this.claudeSessions.payload(metadata.id, { hydrateAttachments })
      : this.cursorSessions.payload(metadata.id, { hydrateAttachments });
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

  private createWorkspace(): string {
    fs.mkdirSync(this.workspacesRoot, { recursive: true, mode: 0o700 });
    const rootStat = fs.lstatSync(this.workspacesRoot);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
      throw new Error("Origin workspaces root must be a real directory");
    }
    const rootRealPath = fs.realpathSync(this.workspacesRoot);
    const workspace = fs.mkdtempSync(path.join(this.workspacesRoot, "session-"));
    try {
      if (!isManagedWorkspace(this.workspacesRoot, workspace, rootRealPath)) {
        throw new Error("Origin workspace escaped its managed root");
      }
      fs.chmodSync(workspace, 0o700);
      this.writeWorkspaceOwner(workspace, null);
      return workspace;
    } catch (error) {
      this.removeWorkspaceIfOwned(workspace, null);
      throw error;
    }
  }

  private writeWorkspaceOwner(workspace: string, sessionId: string | null): void {
    if (!isManagedWorkspace(this.workspacesRoot, workspace)) {
      throw new Error("Origin workspace ownership could not be established");
    }
    const file = path.join(workspace, ORIGIN_WORKSPACE_OWNER_FILE);
    const temp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temp, `${JSON.stringify({ version: 1, sessionId })}\n`, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
      fs.renameSync(temp, file);
    } finally {
      fs.rmSync(temp, { force: true });
    }
  }

  private removeWorkspaceIfOwned(workspace: string, sessionId: string | null): boolean {
    if (!workspaceOwnerMatches(this.workspacesRoot, workspace, sessionId)) return false;
    fs.rmSync(workspace, { recursive: true, force: true });
    return true;
  }

  private writeMetadata(metadata: OriginMetadata): void {
    fs.mkdirSync(this.registryRoot, { recursive: true, mode: 0o700 });
    const registryStat = fs.lstatSync(this.registryRoot);
    if (!registryStat.isDirectory() || registryStat.isSymbolicLink()) {
      throw new Error("Origin registry root must be a real directory");
    }
    const file = this.metadataFile(metadata.id);
    replaceRegularFileSync(file, `${JSON.stringify(metadata, null, 2)}\n`);
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

function normalizeMaterializationId(value?: string): string | null {
  if (value === undefined) return null;
  const normalized = value.trim();
  if (!normalized) throw new Error("materializationId is required");
  if (normalized.length > 200) throw new Error("materializationId must be at most 200 characters");
  return normalized;
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
  return {
    ...metadata,
    materializationId: typeof metadata.materializationId === "string" ? metadata.materializationId : null,
    workspaceOwned: metadata.workspaceOwned === true,
  };
}

function deletionTarget(
  metadata: OriginMetadata,
  workspacesRoot: string,
  expectedSessionId: string,
): OriginDeletionTarget {
  return {
    runtime: metadata.snapshot.runtime,
    workspace: metadata.workspace,
    ownsWorkspace: metadata.workspaceOwned
      && workspaceOwnerMatches(workspacesRoot, metadata.workspace, expectedSessionId),
  };
}

function isManagedWorkspace(root: string, candidate: string, expectedRootRealPath?: string): boolean {
  if (!isWithin(root, candidate)) return false;
  try {
    const rootStat = fs.lstatSync(root);
    const candidateStat = fs.lstatSync(candidate);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()
      || !candidateStat.isDirectory() || candidateStat.isSymbolicLink()) return false;
    const rootRealPath = fs.realpathSync(root);
    if (expectedRootRealPath && rootRealPath !== expectedRootRealPath) return false;
    return isWithin(rootRealPath, fs.realpathSync(candidate));
  } catch {
    return false;
  }
}

function workspaceOwnerMatches(root: string, candidate: string, sessionId: string | null): boolean {
  if (!isManagedWorkspace(root, candidate)) return false;
  const file = path.join(candidate, ORIGIN_WORKSPACE_OWNER_FILE);
  try {
    const owner = JSON.parse(readRegularFileSync(file, 1_024).toString("utf8")) as {
      version?: unknown;
      sessionId?: unknown;
    };
    return owner.version === 1 && owner.sessionId === sessionId;
  } catch {
    return false;
  }
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}
