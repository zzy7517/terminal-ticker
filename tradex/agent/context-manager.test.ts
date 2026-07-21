import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentContextStore } from "./context-store.js";
import { AgentContextManager } from "./context-manager.js";

describe("AgentContextManager", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  });

  function createManager(): AgentContextManager {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tradex-agent-context-"));
    roots.push(root);
    return new AgentContextManager(new AgentContextStore(path.join(root, "chat.sqlite3")));
  }

  it("owns a single logical Agent Context without Chat identity", () => {
    const manager = createManager();
    const context = manager.ensure("cindy");
    expect(manager.get("cindy")?.logicalSessionId).toBe(context.logicalSessionId);
    expect(manager.ensure("cindy").logicalSessionId).toBe(context.logicalSessionId);
  });

  it("binds the current Runtime Session through the trusted agentId", () => {
    const manager = createManager();
    manager.attachSession("cindy", { sessionId: "session-1", runtime: "pi" });
    expect(manager.contextForSession("session-1")?.agentId).toBe("cindy");
    expect(manager.get("cindy")?.activeSessionId).toBe("session-1");
    expect(manager.get("cindy")?.activeRuntime).toBe("pi");
  });

  it("rotates the physical Session without changing logical identity or keeping history", () => {
    const manager = createManager();
    const context = manager.ensure("cindy");
    manager.attachSession("cindy", { sessionId: "session-1", runtime: "pi" });
    manager.rotateSession("cindy", {
      sessionId: "session-2",
      runtime: "pi",
    });
    expect(manager.get("cindy")?.logicalSessionId).toBe(context.logicalSessionId);
    expect(manager.get("cindy")?.activeSessionId).toBe("session-2");
    expect(manager.contextForSession("session-1")).toBeNull();
    expect(manager.contextForSession("session-2")?.agentId).toBe("cindy");
  });

  it("indexes only the newest imported Session onto one Agent Context", () => {
    const manager = createManager();
    manager.indexSessions([
      { sessionId: "old", agentId: "cindy", title: "Old", runtime: "pi", createdAtMs: 1, updatedAtMs: 2 },
      { sessionId: "new", agentId: "cindy", title: "New", runtime: "claude-code", createdAtMs: 3, updatedAtMs: 4 },
    ]);
    manager.indexSessions([
      { sessionId: "older", agentId: "cindy", title: "Older", runtime: "pi", createdAtMs: 0, updatedAtMs: 1 },
    ]);
    expect(manager.get("cindy")?.activeSessionId).toBe("new");
    expect(manager.get("cindy")?.activeRuntime).toBe("claude-code");
    expect(manager.contextForSession("old")).toBeNull();
  });

  it("aborts the active Runtime run by trusted agentId", () => {
    const manager = createManager();
    manager.attachSession("cindy", { sessionId: "session-1", runtime: "pi" });
    let aborted = false;
    const activeRuns = new Map([["session-1", { abort: () => { aborted = true; } }]]);
    expect(manager.resolveActiveBinding("cindy")).toEqual({ agentId: "cindy", sessionId: "session-1" });
    expect(manager.abortActiveRun("cindy", activeRuns)).toEqual({ aborted: true, sessionId: "session-1" });
    expect(aborted).toBe(true);
    expect(manager.abortActiveRun("missing", activeRuns)).toEqual({ aborted: false, sessionId: null });
  });
});
