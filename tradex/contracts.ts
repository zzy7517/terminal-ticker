/**
 * contracts — 前后端共享的 wire 类型（单一事实来源）。
 *
 * 约束：本文件必须零依赖、纯类型（无运行时代码、无 node/DOM 引用），
 * 这样 web/（moduleResolution: Node）与 tradex/（NodeNext）都能直接引用：
 *   后端：import type { X } from "../contracts.js"
 *   前端：import type { X } from '../../../tradex/contracts'
 * 前端必须使用 import type / export type —— 类型在编译期擦除，Vite 不参与解析。
 *
 * 领域模块保留原导出路径（如 channel/domain.ts re-export），调用方无需迁移。
 */

// ── Agent ───────────────────────────────────────────────────────────────────

export type AgentRuntimeId = "pi" | "claude-code" | "cursor";

export interface AgentDefinition {
  id: string;
  name: string;
  description: string;
  /** When set, overrides `id` as the avatar generator seed. */
  avatarSeed: string | null;
  systemPrompt: string | null;
  runtime: AgentRuntimeId;
  provider: string | null;
  model: string | null;
  reasoningEffort: string | null;
  builtIn: boolean;
}

// ── Chat / Channel ──────────────────────────────────────────────────────────

/** 内部可信消息目标：Channel 或 Direct Message（不含 Runtime Session）。 */
export type ChatTarget =
  | { kind: "direct-message"; directMessageId: string }
  | { kind: "channel"; channelId: string };

/** Channel 元数据；version 用于 Held Draft 并发检测。 */
export interface Channel {
  id: string;
  name: string;
  topic: string;
  visibility: "public" | "private";
  version: number;
  createdAtMs: number;
  archivedAtMs: number | null;
}

/** 单条消息上的 reaction 汇总。 */
export interface ChannelReactionSummary {
  emoji: string;
  count: number;
  reacted: boolean;
}

/** Channel 共享消息（权威正文在 ChannelStore，不进 Runtime Session）。 */
export interface ChannelMessage {
  id: string;
  channelId: string;
  channelSeq: number;
  authorType: "human" | "agent" | "system";
  authorId: string;
  kind: string;
  content: string;
  createdAtMs: number;
  editedAtMs: number | null;
  deletedAtMs: number | null;
  reactions: ChannelReactionSummary[];
}

/** Held Draft 状态：暂存 / 已发布 / 已丢弃。 */
export type HeldDraftStatus = "held" | "published" | "discarded";

/** Agent 基于过期 channel.version 发送时暂存的回复（对应 Raft held draft）。 */
export interface HeldDraft {
  id: string;
  agentId: string;
  channelId: string;
  observedVersion: number;
  content: string;
  status: HeldDraftStatus;
  createdAtMs: number;
}

/** Reminder 状态：已排程 / 已触发 / 已取消。 */
export type ReminderStatus = "scheduled" | "triggered" | "cancelled";

/** Channel 一次性提醒（对应 Raft agent reminders）。 */
export interface ChannelReminder {
  id: string;
  agentId: string;
  channelId: string;
  dueAtMs: number;
  note: string;
  status: ReminderStatus;
}

// ── Cron ────────────────────────────────────────────────────────────────────

export interface CronJobStatus {
  name: string;
  cron: string;
  enabled: boolean;
  running: boolean;
  nextRun: string | null;
  lastRunAt: string | null;
  lastStatus: "ok" | "error" | null;
  lastError: string | null;
  systemPrompt: string;
  useMainPrompt: boolean;
  model: string | null;
  userMessage: string;
  maxIterations: number | null;
  maxCandles: number | null;
  tradingEnabled: boolean;
  timezone: string | null;
}

// ── MCP ─────────────────────────────────────────────────────────────────────

export type McpServerStatus = "idle" | "connecting" | "connected" | "failed";

/** Server entry in .mcp.json config */
export interface McpServerEntry {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
  /** Idle timeout in minutes before disconnecting (default: 10, 0 to disable) */
  idleTimeout?: number;
}

/** Global MCP settings */
export interface McpSettings {
  /** Tool name prefix mode: "server" (default) | "none" | "short" */
  toolPrefix?: "server" | "none" | "short";
  /** Idle timeout in minutes (default: 10, 0 to disable) */
  idleTimeout?: number;
}

// ── News ────────────────────────────────────────────────────────────────────

/**
 * NewsItem 的 wire 形状。相比领域模型多出 publishedAt（ISO 字符串），
 * 由 newsItemToPayload 在序列化时注入。
 */
export interface NewsItemPayload {
  url: string;
  source: string;
  title: string;
  summary: string;
  publishedAt: string;
  publishedAtMs: number;
  fetchedAtMs: number;
  keywords: string[];
}
