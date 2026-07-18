import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ChatEventStore } from "../chat-events.js";
import { AgentChatStore } from "./chat-store.js";

describe("AgentChatStore", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  });

  function createStore(): AgentChatStore {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tradex-agent-chat-"));
    roots.push(root);
    return new AgentChatStore(path.join(root, "chat.sqlite3"));
  }

  it("keeps exactly one active Chat per Agent when Human creates New Chat", () => {
    const store = createStore();

    const first = store.create("cindy");
    const second = store.create("cindy");

    expect(second.id).not.toBe(first.id);
    expect(store.listForAgent("cindy")).toEqual([
      expect.objectContaining({ id: second.id, agentId: "cindy", status: "active", ordinal: 2 }),
      expect.objectContaining({ id: first.id, agentId: "cindy", status: "archived", ordinal: 1 }),
    ]);
    expect(store.activeForAgent("cindy")?.id).toBe(second.id);
  });

  it("indexes each existing Session as one imported Chat and keeps the newest active", () => {
    const store = createStore();
    const sessions = [
      { sessionId: "session-old", agentId: "cindy", title: "Old analysis", runtime: "pi" as const, createdAtMs: 100, updatedAtMs: 110 },
      { sessionId: "session-new", agentId: "cindy", title: "New analysis", runtime: "claude-code" as const, createdAtMs: 200, updatedAtMs: 220 },
    ];

    store.indexSessions(sessions);
    store.indexSessions(sessions);

    const chats = store.listForAgent("cindy");
    expect(chats).toHaveLength(2);
    expect(chats[0]).toEqual(expect.objectContaining({
      title: "New analysis",
      status: "active",
      activeSessionId: "session-new",
      generationCount: 1,
    }));
    expect(chats[1]).toEqual(expect.objectContaining({
      title: "Old analysis",
      status: "archived",
      activeSessionId: "session-old",
      generationCount: 1,
    }));
    expect(store.chatForSession("session-old")?.id).toBe(chats[1].id);
    expect(store.listSessions(chats[0].id)).toEqual([
      expect.objectContaining({ sessionId: "session-new", generation: 1, runtime: "claude-code" }),
    ]);
  });

  it("removes a deleted Session generation without leaving a dangling active Session", () => {
    const store = createStore();
    const chat = store.create("cindy");
    store.attachSession(chat.id, { sessionId: "session-1", runtime: "pi" });

    store.removeSession("session-1");

    expect(store.get(chat.id)).toEqual(expect.objectContaining({
      activeSessionId: null,
      generationCount: 0,
    }));
    expect(store.chatForSession("session-1")).toBeNull();
  });

  it("emits Direct Chat events through the same ChatTarget contract", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tradex-agent-chat-events-"));
    roots.push(root);
    const dbPath = path.join(root, "chat.sqlite3");
    const store = new AgentChatStore(dbPath);
    const events = new ChatEventStore(dbPath);

    const chat = store.create("cindy");

    expect(events.list({ afterSeq: 0 }).events).toEqual([
      expect.objectContaining({
        type: "direct-chat.created",
        target: { kind: "direct-chat", agentId: "cindy", chatId: chat.id },
        entityType: "direct-chat",
        entityId: chat.id,
      }),
    ]);
  });
});
