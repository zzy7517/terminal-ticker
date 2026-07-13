import fs from "node:fs";
import path from "node:path";
import {
  SessionManager,
  type SessionInfo,
  type SessionMessageEntry,
} from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type {
  AssistantMessage,
  ImageContent,
  TextContent,
  ToolResultMessage,
  UserMessage,
} from "@earendil-works/pi-ai";
import { defaultCacheDir } from "../../../db.js";
import { toPiProviderId } from "./models/constants.js";
import { DEFAULT_AGENT_ID } from "../../agent_store.js";

const PI_SESSIONS_SUBDIR = "pi_sessions";
export const EXTERNAL_CONTEXT_ENTRY = "tradex_external_context";
export const AGENT_SNAPSHOT_ENTRY = "tradex_agent_snapshot";

export interface SessionAgentSnapshot {
  agentId: string;
  agentName: string;
  runtime: "pi";
  systemPrompt: string;
  provider: string;
  model: string;
  reasoningEffort: string;
}

const LEGACY_AGENT_SNAPSHOT: SessionAgentSnapshot = {
  agentId: DEFAULT_AGENT_ID,
  agentName: "Default Agent",
  runtime: "pi",
  systemPrompt: "",
  provider: "",
  model: "",
  reasoningEffort: "",
};

export function appendAgentSnapshot(manager: SessionManager, snapshot: SessionAgentSnapshot): void {
  if (manager.getEntries().some((entry) => entry.type === "custom" && entry.customType === AGENT_SNAPSHOT_ENTRY)) return;
  manager.appendCustomEntry(AGENT_SNAPSHOT_ENTRY, snapshot);
}

export function readAgentSnapshot(manager: SessionManager): SessionAgentSnapshot {
  const entry = manager.getEntries().find((candidate) =>
    candidate.type === "custom" && candidate.customType === AGENT_SNAPSHOT_ENTRY
  );
  if (!entry || entry.type !== "custom") return { ...LEGACY_AGENT_SNAPSHOT };
  const value = entry.data as Partial<SessionAgentSnapshot> | undefined;
  if (!value || typeof value.agentId !== "string") return { ...LEGACY_AGENT_SNAPSHOT };
  return {
    agentId: value.agentId,
    agentName: typeof value.agentName === "string" ? value.agentName : value.agentId,
    runtime: "pi",
    systemPrompt: typeof value.systemPrompt === "string" ? value.systemPrompt : "",
    provider: typeof value.provider === "string" ? value.provider : "",
    model: typeof value.model === "string" ? value.model : "",
    reasoningEffort: typeof value.reasoningEffort === "string" ? value.reasoningEffort : "",
  };
}

export function piSessionsDir(): string {
  return path.join(defaultCacheDir(), PI_SESSIONS_SUBDIR);
}

export function piProviderName(provider: string): string {
  return toPiProviderId(provider);
}

export function piSessionFileExists(manager: SessionManager): boolean {
  const filePath = manager.getSessionFile();
  return Boolean(filePath && fs.existsSync(filePath));
}

export function createPiSession(input: {
  title?: string;
  cwd?: string;
  sessionDir?: string;
} = {}): SessionManager {
  const manager = SessionManager.create(
    input.cwd ?? process.cwd(),
    input.sessionDir ?? piSessionsDir(),
  );
  manager.appendSessionInfo(input.title?.trim() || "New Agent Session");
  return manager;
}

export async function listPiSessions(sessionDir = piSessionsDir()): Promise<SessionInfo[]> {
  return SessionManager.listAll(sessionDir);
}

export function listPiSessionManagersSync(sessionDir = piSessionsDir()): SessionManager[] {
  if (!fs.existsSync(sessionDir)) return [];
  return fs.readdirSync(sessionDir)
    .filter((name) => name.endsWith(".jsonl"))
    .flatMap((name) => {
      try {
        return [SessionManager.open(path.join(sessionDir, name), sessionDir, process.cwd())];
      } catch {
        return [];
      }
    })
    .sort((left, right) => {
      const leftTime = left.getBranch().at(-1)?.timestamp ?? left.getHeader()?.timestamp ?? "";
      const rightTime = right.getBranch().at(-1)?.timestamp ?? right.getHeader()?.timestamp ?? "";
      return rightTime.localeCompare(leftTime);
    });
}

export async function openPiSession(
  sessionId: string,
  sessionDir = piSessionsDir(),
): Promise<SessionManager | null> {
  const info = (await listPiSessions(sessionDir)).find((item) => item.id === sessionId);
  if (!info) return null;
  assertPathInside(info.path, sessionDir);
  return SessionManager.open(info.path, sessionDir, process.cwd());
}

export async function deletePiSession(
  sessionId: string,
  sessionDir = piSessionsDir(),
): Promise<boolean> {
  const info = (await listPiSessions(sessionDir)).find((item) => item.id === sessionId);
  if (!info) return false;
  assertPathInside(info.path, sessionDir);
  fs.unlinkSync(info.path);
  return true;
}

export function piSessionPayload(manager: SessionManager): Record<string, unknown> {
  const header = manager.getHeader();
  if (!header) throw new Error("Pi session header is missing");
  const entries = manager.getBranch();
  const messageEntries = entries.filter(
    (entry): entry is SessionMessageEntry => entry.type === "message",
  );
  const messages = messageEntries.map((entry) => projectMessage(manager.getSessionId(), entry));
  const context = manager.buildSessionContext();
  const model = context.model;
  const firstUser = messages.find((message) => message.role === "user");
  const title = manager.getSessionName() || String(firstUser?.content || "").slice(0, 60) || "New Agent Session";
  const externalContext = entries.some((entry) =>
    entry.type === "custom" && entry.customType === EXTERNAL_CONTEXT_ENTRY
  ) || messageEntries.some((entry) => messageUsesExternalContext(entry.message));
  const agentSnapshot = readAgentSnapshot(manager);

  return {
    session: {
      id: manager.getSessionId(),
      title,
      provider: model?.provider ?? "",
      model: model?.modelId ?? "",
      createdAt: header.timestamp,
      updatedAt: entries.at(-1)?.timestamp ?? header.timestamp,
      active: true,
      apiMode: null,
      reasoningEffort: context.thinkingLevel || null,
      agentId: agentSnapshot.agentId,
      agentName: agentSnapshot.agentName,
      runtime: agentSnapshot.runtime,
      memory: { externalContext },
    },
    messages,
    contextUsage: computeContextUsage(messageEntries),
    sessionStats: computeSessionStats(manager.getSessionId(), messageEntries),
  };
}

export function piSessionSummary(info: SessionInfo, manager: SessionManager): Record<string, unknown> {
  const payload = piSessionPayload(manager);
  const session = payload.session as Record<string, unknown>;
  const stats = payload.sessionStats as Record<string, unknown>;
  return {
    ...session,
    active: false,
    messageCount: stats.totalMessages ?? info.messageCount,
    preview: info.firstMessage || "(no messages)",
    contextUsage: payload.contextUsage,
  };
}

function projectMessage(sessionId: string, entry: SessionMessageEntry): Record<string, unknown> {
  const message = entry.message;
  const base = {
    id: entry.id,
    sessionId,
    role: message.role,
    content: "",
    createdAt: entry.timestamp,
    metadata: null as Record<string, unknown> | null,
    error: null as string | null,
  };

  if (message.role === "user") {
    const user = message as UserMessage;
    return {
      ...base,
      content: textFromContent(user.content),
      metadata: imageMetadata(user.content),
    };
  }
  if (message.role === "assistant") {
    const assistant = message as AssistantMessage;
    const toolCalls = assistant.content
      .filter((item): item is Extract<AssistantMessage["content"][number], { type: "toolCall" }> =>
        item.type === "toolCall"
      )
      .map((item) => ({
        id: item.id,
        name: item.name,
        arguments: item.arguments,
      }));
    return {
      ...base,
      content: assistant.content
        .filter((item): item is TextContent => item.type === "text")
        .map((item) => item.text)
        .join(""),
      metadata: {
        totalTokens: assistant.usage.totalTokens,
        promptTokens: assistant.usage.input,
        completionTokens: assistant.usage.output,
        cacheRead: assistant.usage.cacheRead,
        cacheWrite: assistant.usage.cacheWrite,
        toolCalls,
      },
      error: assistant.errorMessage ?? null,
    };
  }
  if (message.role === "toolResult") {
    const result = message as ToolResultMessage;
    return {
      ...base,
      content: textFromContent(result.content),
      metadata: {
        toolCallId: result.toolCallId,
        toolName: result.toolName,
        error: result.isError,
        ...(imageMetadata(result.content) ?? {}),
      },
      error: result.isError ? textFromContent(result.content) : null,
    };
  }
  return base;
}

function computeContextUsage(entries: SessionMessageEntry[]): Record<string, unknown> | null {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const message = entries[index].message;
    if (message.role !== "assistant") continue;
    const usage = (message as AssistantMessage).usage;
    if (!usage || (!usage.input && !usage.totalTokens)) continue;
    return {
      tokens: usage.input || usage.totalTokens,
      promptTokens: usage.input,
      totalTokens: usage.totalTokens,
    };
  }
  return null;
}

function computeSessionStats(sessionId: string, entries: SessionMessageEntry[]): Record<string, unknown> {
  let userMessages = 0;
  let assistantMessages = 0;
  let toolCalls = 0;
  let toolResults = 0;
  let input = 0;
  let output = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  for (const entry of entries) {
    const message = entry.message;
    if (message.role === "user") userMessages += 1;
    if (message.role === "toolResult") toolResults += 1;
    if (message.role !== "assistant") continue;
    assistantMessages += 1;
    const assistant = message as AssistantMessage;
    toolCalls += assistant.content.filter((item) => item.type === "toolCall").length;
    input += assistant.usage.input;
    output += assistant.usage.output;
    cacheRead += assistant.usage.cacheRead;
    cacheWrite += assistant.usage.cacheWrite;
  }
  return {
    sessionId,
    userMessages,
    assistantMessages,
    toolCalls,
    toolResults,
    totalMessages: entries.length,
    tokens: {
      input,
      output,
      cacheRead,
      cacheWrite,
      total: input + output + cacheRead + cacheWrite,
    },
  };
}

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((item): item is TextContent =>
      Boolean(item && typeof item === "object" && (item as { type?: unknown }).type === "text")
    )
    .map((item) => item.text)
    .join("");
}

function imageMetadata(content: unknown): Record<string, unknown> | null {
  if (!Array.isArray(content)) return null;
  const images = content
    .filter((item): item is ImageContent =>
      Boolean(item && typeof item === "object" && (item as { type?: unknown }).type === "image")
    )
    .map((item) => ({ data: item.data, mimeType: item.mimeType }));
  return images.length > 0 ? { images } : null;
}

function messageUsesExternalContext(message: AgentMessage): boolean {
  if (message.role === "toolResult") {
    return externalToolName((message as ToolResultMessage).toolName);
  }
  if (message.role !== "assistant") return false;
  return (message as AssistantMessage).content.some(
    (item) => item.type === "toolCall" && externalToolName(item.name),
  );
}

function externalToolName(name: string): boolean {
  return new Set([
    "web_search",
    "web_fetch",
    "get_recent_news",
    "refresh_news",
    "browser_open_page",
    "browser_screenshot",
    "browser_status",
  ]).has(name);
}

function assertPathInside(filePath: string, root: string): void {
  const resolvedRoot = path.resolve(root);
  const resolvedFile = path.resolve(filePath);
  if (resolvedFile !== resolvedRoot && !resolvedFile.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error("session path escapes the Tradex session directory");
  }
}
