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

  it("binds Runtime Session generations through the trusted agentId", () => {
    const manager = createManager();
    manager.attachSession("cindy", { sessionId: "session-1", runtime: "pi" });
    expect(manager.contextForSession("session-1")?.agentId).toBe("cindy");
    expect(manager.listSessions("cindy")).toEqual([
      expect.objectContaining({ generation: 1, sessionId: "session-1" }),
    ]);
  });

  it("rotates a physical Session generation without changing logical identity", () => {
    const manager = createManager();
    const context = manager.ensure("cindy");
    manager.attachSession("cindy", { sessionId: "session-1", runtime: "pi" });
    manager.rotateSession("cindy", {
      sessionId: "session-2",
      runtime: "pi",
      reason: "context-overflow",
    });
    expect(manager.get("cindy")?.logicalSessionId).toBe(context.logicalSessionId);
    expect(manager.listSessions("cindy")).toEqual([
      expect.objectContaining({ generation: 1, sessionId: "session-1" }),
      expect.objectContaining({ generation: 2, sessionId: "session-2", rotationReason: "context-overflow" }),
    ]);
  });

  it("indexes imported Sessions onto one Agent Context", () => {
    const manager = createManager();
    manager.indexSessions([
      { sessionId: "old", agentId: "cindy", title: "Old", runtime: "pi", createdAtMs: 1, updatedAtMs: 2 },
      { sessionId: "new", agentId: "cindy", title: "New", runtime: "claude-code", createdAtMs: 3, updatedAtMs: 4 },
    ]);
    manager.indexSessions([
      { sessionId: "old", agentId: "cindy", title: "Old", runtime: "pi", createdAtMs: 1, updatedAtMs: 2 },
    ]);
    expect(manager.listSessions("cindy")).toHaveLength(2);
  });
});
