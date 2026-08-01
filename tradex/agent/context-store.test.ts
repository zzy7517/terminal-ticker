import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentContextStore } from "./context-store.js";

describe("AgentContextStore", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  });

  function createStore(): AgentContextStore {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tradex-agent-context-"));
    roots.push(root);
    return new AgentContextStore(path.join(root, "chat.sqlite3"));
  }

  it("owns a single logical Agent Context without Chat identity", () => {
    const store = createStore();
    const context = store.ensure("cindy");
    expect(store.get("cindy")?.logicalSessionId).toBe(context.logicalSessionId);
    expect(store.ensure("cindy").logicalSessionId).toBe(context.logicalSessionId);
  });

  it("binds the current Runtime Session through the trusted agentId", () => {
    const store = createStore();
    store.attachSession("cindy", { sessionId: "session-1", runtime: "pi" });
    expect(store.contextForSession("session-1")?.agentId).toBe("cindy");
    expect(store.get("cindy")?.activeSessionId).toBe("session-1");
    expect(store.get("cindy")?.activeRuntime).toBe("pi");
  });

  it("rotates the physical Session without changing logical identity or keeping history", () => {
    const store = createStore();
    const context = store.ensure("cindy");
    store.attachSession("cindy", { sessionId: "session-1", runtime: "pi" });
    store.attachSession("cindy", { sessionId: "session-2", runtime: "pi" });
    expect(store.get("cindy")?.logicalSessionId).toBe(context.logicalSessionId);
    expect(store.get("cindy")?.activeSessionId).toBe("session-2");
    expect(store.contextForSession("session-1")).toBeNull();
    expect(store.contextForSession("session-2")?.agentId).toBe("cindy");
  });

  it("rejects binding a Session already owned by another Agent", () => {
    const store = createStore();
    store.attachSession("cindy", { sessionId: "session-1", runtime: "pi" });
    expect(() => store.attachSession("dana", { sessionId: "session-1", runtime: "pi" })).toThrow(
      /belongs to another Agent/,
    );
  });

  it("indexes only the newest imported Session onto one Agent Context", () => {
    const store = createStore();
    store.indexSessions([
      { sessionId: "old", agentId: "cindy", title: "Old", runtime: "pi", createdAtMs: 1, updatedAtMs: 2 },
      { sessionId: "new", agentId: "cindy", title: "New", runtime: "claude-code", createdAtMs: 3, updatedAtMs: 4 },
    ]);
    store.indexSessions([
      { sessionId: "older", agentId: "cindy", title: "Older", runtime: "pi", createdAtMs: 0, updatedAtMs: 1 },
    ]);
    expect(store.get("cindy")?.activeSessionId).toBe("new");
    expect(store.get("cindy")?.activeRuntime).toBe("claude-code");
    expect(store.contextForSession("old")).toBeNull();
  });
});
