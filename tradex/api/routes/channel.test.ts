import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ChatEventStore } from "../../chat/events.js";
import { ChatOverlayStore } from "../../chat/overlay.js";
import { ChatReferenceManager } from "../../chat/references.js";
import { channelTarget, directMessageTarget } from "../../channel/domain.js";
import { ChannelStore } from "../../channel/store.js";
import { MessageStore } from "../../chat/message-store.js";
import { InboxStore } from "../../chat/inbox-store.js";
import { UnreadStore } from "../../chat/unread-store.js";
import { AgentContextStore } from "../../agent/context-store.js";
import { AgentContextManager } from "../../agent/context-manager.js";
import { chatEventRoutes } from "./chat.js";
import { channelRoutes } from "./channel.js";
import type { AppRuntime } from "../runtime.js";

describe("Channel HTTP API", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  });

  function runtime(): AppRuntime {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tradex-channel-api-"));
    roots.push(root);
    const dbPath = path.join(root, "chat.sqlite3");
    const agentContextManager = new AgentContextManager(new AgentContextStore(dbPath));
    const channelStore = new ChannelStore(dbPath);
    const messageStore = new MessageStore(dbPath);
    const inboxStore = new InboxStore(dbPath);
    const unreadStore = new UnreadStore(dbPath);
    return {
      agentContextManager,
      channelStore,
      messageStore,
      inboxStore,
      unreadStore,
      agentCoordinator: null,
      agentStore: { list: () => [], get: () => null },
      chatEventStore: new ChatEventStore(dbPath),
      chatReferences: new ChatReferenceManager(
        channelStore,
        messageStore,
        agentContextManager,
        new ChatOverlayStore(dbPath),
      ),
    } as unknown as AppRuntime;
  }

  it("lets Human create a Channel and append a message", async () => {
    const routes = channelRoutes(runtime());
    const create = await routes.request("/api/channels", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "btc-research", topic: "BTC research" }),
    });
    const { channel } = await create.json() as { channel: { id: string } };
    const send = await routes.request(`/api/channels/${channel.id}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "Start analysis" }),
    });
    const timeline = await routes.request(`/api/channels/${channel.id}/messages`);
    const payload = await timeline.json() as { messages: Array<{ content: string }> };

    expect(create.status).toBe(201);
    expect(send.status).toBe(201);
    expect(payload.messages).toEqual([expect.objectContaining({ content: "Start analysis" })]);
  });

  it("lets Human update and archive a Channel without deleting its history", async () => {
    const appRuntime = runtime();
    const routes = channelRoutes(appRuntime);
    const channel = appRuntime.channelStore.createChannel({ name: "btc-research" });
    appRuntime.channelStore.appendMessage({ channelId: channel.id, authorId: "owner", content: "Keep me" });

    const update = await routes.request(`/api/channels/${channel.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ topic: "Updated topic", visibility: "private" }),
    });
    const archived = await routes.request(`/api/channels/${channel.id}`, { method: "DELETE" });

    expect(await update.json()).toEqual(expect.objectContaining({
      channel: expect.objectContaining({ topic: "Updated topic", visibility: "private", version: 2 }),
    }));
    expect(await archived.json()).toEqual(expect.objectContaining({
      channel: expect.objectContaining({ archivedAtMs: expect.any(Number), version: 3 }),
    }));
    expect(appRuntime.channelStore.listChannels()).toEqual([]);
    expect(appRuntime.channelStore.listMessages({ channelId: channel.id }).messages).toEqual([
      expect.objectContaining({ content: "Keep me" }),
    ]);
  });

  it("supports Human edit, reaction, and audited delete routes", async () => {
    const appRuntime = runtime();
    const routes = channelRoutes(appRuntime);
    const channel = appRuntime.channelStore.createChannel({ name: "btc-research" });
    const root = appRuntime.channelStore.appendMessage({ channelId: channel.id, authorId: "owner", content: "Initial" });

    const edit = await routes.request(`/api/channels/messages/${root.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ channelId: channel.id, content: "Updated" }),
    });
    const reaction = await routes.request(`/api/channels/messages/${root.id}/reactions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ channelId: channel.id, emoji: "👍" }),
    });
    const deleted = await routes.request(`/api/channels/messages/${root.id}`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ channelId: channel.id }),
    });

    expect(edit.status).toBe(200);
    expect(reaction.status).toBe(201);
    expect(await reaction.json()).toEqual(expect.objectContaining({
      message: expect.objectContaining({
        content: "Updated",
        reactions: [{ emoji: "👍", count: 1, reacted: true }],
      }),
    }));
    expect(await deleted.json()).toEqual(expect.objectContaining({
      message: expect.objectContaining({ content: "", deletedAtMs: expect.any(Number) }),
      revisions: [
        expect.objectContaining({ action: "edit", content: "Initial" }),
        expect.objectContaining({ action: "delete", content: "Updated" }),
      ],
    }));
  });

  it("bootstraps from a snapshot and resumes chat events after a sequence", async () => {
    const appRuntime = runtime();
    const channel = appRuntime.channelStore.createChannel({ name: "btc-research" });
    appRuntime.channelStore.appendMessage({ channelId: channel.id, authorId: "owner", content: "Start" });
    const routes = chatEventRoutes(appRuntime);

    const bootstrap = await routes.request("/api/chat/bootstrap");
    const snapshot = await bootstrap.json() as { channels: unknown[]; lastEventSeq: number };
    expect(snapshot.channels).toHaveLength(1);
    expect(snapshot.lastEventSeq).toBe(2);

    appRuntime.channelStore.appendMessage({ channelId: channel.id, authorId: "owner", content: "Next" });
    const response = await routes.request("/api/chat/events?after_seq=2");
    const reader = response.body!.getReader();
    const first = await reader.read();
    await reader.cancel();
    const frame = new TextDecoder().decode(first.value);

    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(frame).toContain("id: 3");
    expect(frame).toContain('"type":"message.created"');
  });

  it("persists Saved and Pinned message references through ChatTarget", async () => {
    const appRuntime = runtime();
    const channel = appRuntime.channelStore.createChannel({ name: "btc-research" });
    const message = appRuntime.channelStore.appendMessage({ channelId: channel.id, authorId: "owner", content: "Keep" });
    const routes = chatEventRoutes(appRuntime);
    const body = JSON.stringify({ target: channelTarget(channel.id), messageId: message.id });

    const saved = await routes.request("/api/chat/saved", {
      method: "POST", headers: { "content-type": "application/json" }, body,
    });
    const pinned = await routes.request("/api/chat/pins", {
      method: "POST", headers: { "content-type": "application/json" }, body,
    });
    const bootstrap = await routes.request("/api/chat/bootstrap");
    const snapshot = await bootstrap.json() as { saved: unknown[]; pinned: unknown[] };

    expect(saved.status).toBe(200);
    expect(pinned.status).toBe(200);
    expect(snapshot.saved).toEqual([expect.objectContaining({ messageId: message.id, target: channelTarget(channel.id) })]);
    expect(snapshot.pinned).toEqual([expect.objectContaining({ messageId: message.id, target: channelTarget(channel.id) })]);
  });

  it("rejects a forged Direct Message target for generic message references", async () => {
    const appRuntime = runtime();
    const dm = appRuntime.messageStore.ensureHumanAgentDm("cindy");
    appRuntime.agentContextManager.ensure("cindy");
    appRuntime.agentContextManager.attachSession("cindy", { sessionId: "session-1", runtime: "pi" });
    const routes = chatEventRoutes(appRuntime);

    const missingMessage = await routes.request("/api/chat/saved", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ target: directMessageTarget(dm.id), messageId: "missing-uuid" }),
    });
    const forged = await routes.request("/api/chat/saved", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ target: directMessageTarget("00000000-0000-4000-8000-000000000000"), messageId: "session-1:1" }),
    });

    expect(missingMessage.status).toBe(400);
    expect(forged.status).toBe(400);
  });
});
