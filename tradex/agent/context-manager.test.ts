import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentChatStore } from "./chat-store.js";
import { AgentContextManager } from "./context-manager.js";

describe("AgentContextManager", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  });

  function createManager(): AgentContextManager {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tradex-agent-context-"));
    roots.push(root);
    return new AgentContextManager(new AgentChatStore(path.join(root, "chat.sqlite3")));
  }

  it("owns active Chat creation and Agent/Chat identity validation", () => {
    const manager = createManager();

    const chat = manager.ensureActiveChat("cindy");

    expect(manager.listChats("cindy")).toEqual([expect.objectContaining({ id: chat.id, status: "active" })]);
    expect(manager.requireChat("cindy", chat.id).id).toBe(chat.id);
    expect(() => manager.requireChat("other", chat.id)).toThrow("Chat not found for Agent");
  });

  it("creates a clean New Chat only while the Agent is idle", () => {
    const manager = createManager();
    const first = manager.ensureActiveChat("cindy");

    expect(() => manager.createNewChat("cindy", true)).toThrow("cannot create New Chat while Agent is running");
    const second = manager.createNewChat("cindy", false);

    expect(second.id).not.toBe(first.id);
    expect(manager.requireChat("cindy", first.id).status).toBe("archived");
    expect(manager.requireWritableChat("cindy", first.id)).toBeNull();
    expect(manager.requireWritableChat("cindy", second.id)?.id).toBe(second.id);
  });

  it("binds Runtime Session generations through the trusted Agent/Chat pair", () => {
    const manager = createManager();
    const chat = manager.ensureActiveChat("cindy");

    manager.attachSession("cindy", chat.id, { sessionId: "session-1", runtime: "pi" });

    expect(manager.chatForSession("session-1")?.id).toBe(chat.id);
    expect(() => manager.attachSession("other", chat.id, { sessionId: "forged", runtime: "pi" }))
      .toThrow("Chat not found for Agent");
  });

  it("rotates a physical Session generation without changing Chat identity", () => {
    const manager = createManager();
    const chat = manager.ensureActiveChat("cindy");
    manager.attachSession("cindy", chat.id, { sessionId: "session-1", runtime: "pi" });

    manager.rotateSession("cindy", chat.id, {
      sessionId: "session-2",
      runtime: "pi",
      reason: "context-overflow",
    });

    expect(manager.listSessions(chat.id)).toEqual([
      expect.objectContaining({ generation: 1, sessionId: "session-1", rotationReason: "initial" }),
      expect.objectContaining({ generation: 2, sessionId: "session-2", rotationReason: "context-overflow" }),
    ]);
    expect(manager.ensureActiveChat("cindy").id).toBe(chat.id);
  });
});
