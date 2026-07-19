import type { AppRuntime } from "../api/runtime.js";
import { HUMAN_OWNER_ID } from "../chat/message-store.js";
import {
  listPiSessions,
  openPiSession,
  piSessionPayload,
  piSessionSummary,
} from "./runtime/pi/sessions.js";

/** Indexes every persisted Runtime Session as one imported Chat during startup. */
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
      title: String(summary.title || "Imported Chat"),
      runtime: "pi" as const,
      createdAtMs: Date.parse(String(summary.createdAt)) || Date.now(),
      updatedAtMs: Date.parse(String(summary.updatedAt)) || Date.now(),
    }];
  });
  const claudeSessions = runtime.claudeSessions.list().map((summary) => ({
    sessionId: String(summary.id),
    agentId: String(summary.agentId || "default"),
    title: String(summary.title || "Imported Chat"),
    runtime: "claude-code" as const,
    createdAtMs: Date.parse(String(summary.createdAt)) || Date.now(),
    updatedAtMs: Date.parse(String(summary.updatedAt)) || Date.now(),
  }));
  runtime.agentContextManager.indexSessions([...piSessions, ...claudeSessions]);
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
 * Idempotently imports user/assistant text from legacy Runtime Sessions into the
 * unique Human-Agent DM. importKey = `${sessionId}:${messageId}`; original
 * Session files remain the execution archive.
 */
export async function importLegacySessionMessages(runtime: AppRuntime): Promise<{ imported: number; skipped: number }> {
  const candidates: ImportableSessionMessage[] = [];

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

  let imported = 0;
  let skipped = 0;
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
