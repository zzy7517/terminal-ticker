/**
 * chat-index — 启动时索引，以及遗留 Session → Shared DM 导入。
 *
 * 将 Runtime Session 索引进 AgentContext generations，并用 import_key
 * 幂等复制遗留 Session 消息到唯一 Human–Agent DM。原始 Session 文件保留为执行归档。
 */
import type { AppRuntime } from "../api/runtime.js";
import { isActivationWakeContent } from "../chat/prompts.js";
import { HUMAN_OWNER_ID } from "../chat/message-store.js";
import {
  listPiSessions,
  openPiSession,
  piSessionPayload,
  piSessionSummary,
} from "./runtime/pi/sessions.js";

/** 启动时把每个持久化 Runtime Session 索引进 AgentContext generations。 */
export async function indexPersistedAgentSessions(runtime: AppRuntime): Promise<void> {
  const listed = await listPiSessions();
  const managers = await Promise.all(listed.map((row) => openPiSession(row.id)));
  const piSessions = listed.flatMap((row, index) => {
    const manager = managers[index];
    if (!manager) return [];
    const summary = piSessionSummary(row, manager);
    return [{
      sessionId: String(summary.id),
      agentId: String(summary.agentId || "default"),
      title: String(summary.title || "Imported Session"),
      runtime: "pi" as const,
      createdAtMs: Date.parse(String(summary.createdAt)) || Date.now(),
      updatedAtMs: Date.parse(String(summary.updatedAt)) || Date.now(),
    }];
  });
  const claudeSessions = runtime.claudeSessions.list().map((summary) => ({
    sessionId: String(summary.id),
    agentId: String(summary.agentId || "default"),
    title: String(summary.title || "Imported Session"),
    runtime: "claude-code" as const,
    createdAtMs: Date.parse(String(summary.createdAt)) || Date.now(),
    updatedAtMs: Date.parse(String(summary.updatedAt)) || Date.now(),
  }));
  const cursorSessions = runtime.cursorSessions.list().map((summary) => ({
    sessionId: String(summary.id),
    agentId: String(summary.agentId || "default"),
    title: String(summary.title || "Imported Session"),
    runtime: "cursor" as const,
    createdAtMs: Date.parse(String(summary.createdAt)) || Date.now(),
    updatedAtMs: Date.parse(String(summary.updatedAt)) || Date.now(),
  }));
  runtime.agentContextManager.indexSessions([...piSessions, ...claudeSessions, ...cursorSessions]);
}

interface ImportableSessionMessage {
  sessionId: string;
  messageId: string;
  agentId: string;
  authorType: "human" | "agent";
  content: string;
  createdAtMs: number;
}

/**
 * 幂等导入遗留 Runtime Session 的 user/assistant 文本到唯一 Human-Agent DM。
 * importKey = `${sessionId}:${messageId}`；原始 Session 文件保留为执行归档。
 */
export async function importLegacySessionMessages(runtime: AppRuntime): Promise<{ imported: number; skipped: number }> {
  const candidates: ImportableSessionMessage[] = [];
  let imported = 0;
  let skipped = 0;

  const listed = await listPiSessions();
  for (const row of listed) {
    const manager = await openPiSession(row.id);
    if (!manager) continue;
    const payload = piSessionPayload(manager);
    const session = payload.session as Record<string, unknown>;
    const sessionId = String(session.id);
    const agentId = String(session.agentId || "default");
    const messages = Array.isArray(payload.messages) ? payload.messages : [];
    for (const raw of messages) {
      const message = raw as Record<string, unknown>;
      const role = String(message.role ?? "");
      if (role !== "user" && role !== "assistant") continue;
      const content = String(message.content ?? "").trim();
      if (!content) continue;
      // Coordinator wake / 历史误写入的 ops prompt 不是 Human–Agent 对话。
      if (role === "user" && isActivationWakeContent(content)) {
        skipped += 1;
        continue;
      }
      candidates.push({
        sessionId,
        messageId: String(message.id ?? ""),
        agentId,
        authorType: role === "user" ? "human" : "agent",
        content,
        createdAtMs: Date.parse(String(message.createdAt ?? "")) || Date.now(),
      });
    }
  }

  for (const summary of runtime.claudeSessions.list()) {
    const sessionId = String(summary.id);
    const agentId = String(summary.agentId || "default");
    for (const message of runtime.claudeSessions.messages(sessionId)) {
      if (message.role !== "user" && message.role !== "assistant") continue;
      const content = message.content.trim();
      if (!content) continue;
      if (message.role === "user" && isActivationWakeContent(content)) {
        skipped += 1;
        continue;
      }
      candidates.push({
        sessionId,
        messageId: message.id,
        agentId,
        authorType: message.role === "user" ? "human" : "agent",
        content,
        createdAtMs: Date.parse(message.createdAt) || Date.now(),
      });
    }
  }

  candidates.sort((left, right) => left.createdAtMs - right.createdAtMs
    || left.sessionId.localeCompare(right.sessionId)
    || left.messageId.localeCompare(right.messageId));

  for (const item of candidates) {
    if (!item.messageId) {
      skipped += 1;
      continue;
    }
    const importKey = `${item.sessionId}:${item.messageId}`;
    if (runtime.messageStore.getMessageByImportKey(importKey)) {
      skipped += 1;
      continue;
    }
    const dm = runtime.messageStore.ensureHumanAgentDm(item.agentId);
    runtime.messageStore.appendMessage({
      directMessageId: dm.id,
      authorType: item.authorType,
      authorId: item.authorType === "human" ? HUMAN_OWNER_ID : item.agentId,
      content: item.content,
      createdAtMs: item.createdAtMs,
      importKey,
    });
    imported += 1;
  }
  return { imported, skipped };
}
