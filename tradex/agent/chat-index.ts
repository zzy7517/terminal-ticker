import type { AppRuntime } from "../api/runtime.js";
import {
  listPiSessions,
  openPiSession,
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
