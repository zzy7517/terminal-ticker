import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ChatEventStore } from "../../chat/events.js";
import { channelTarget } from "../../chat/target.js";
import { ChannelStore } from "../../channel/store.js";
import { MessageStore } from "../../chat/message-store.js";
import { InboxStore } from "../../chat/inbox-store.js";
import { UnreadStore } from "../../chat/unread-store.js";
import { AgentContextStore } from "../../agent/context-store.js";

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
    const agentContexts = new AgentContextStore(dbPath);
    const channelStore = new ChannelStore(dbPath);
    const messageStore = new MessageStore(dbPath);
    const inboxStore = new InboxStore(dbPath);
    const unreadStore = new UnreadStore(dbPath);
    return {
      agentContexts,
      channelStore,
      messageStore,
      inboxStore,
      unreadStore,
      agentCoordinator: null,
      agentStore: { list: () => [], get: () => null },
      chatEventStore: new ChatEventStore(dbPath),
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

  it("supports Human reaction add and remove routes", async () => {
    const appRuntime = runtime();
    const routes = channelRoutes(appRuntime);
    const channel = appRuntime.channelStore.createChannel({ name: "btc-research" });
    const root = appRuntime.channelStore.appendMessage({ channelId: channel.id, authorId: "owner", content: "Initial" });

    const reaction = await routes.request(`/api/channels/messages/${root.id}/reactions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ channelId: channel.id, emoji: "👍" }),
    });
    const removed = await routes.request(`/api/channels/messages/${root.id}/reactions`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ channelId: channel.id, emoji: "👍" }),
    });

    expect(reaction.status).toBe(201);
    expect(await reaction.json()).toEqual(expect.objectContaining({
      message: expect.objectContaining({
        content: "Initial",
        reactions: [{ emoji: "👍", count: 1, reacted: true }],
      }),
    }));
    expect(removed.status).toBe(200);
    expect(await removed.json()).toEqual(expect.objectContaining({
      message: expect.objectContaining({
        content: "Initial",
        reactions: [],
      }),
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

  it("bootstraps channels without reference collections", async () => {
    const appRuntime = runtime();
    appRuntime.channelStore.createChannel({ name: "btc-research" });
    const routes = chatEventRoutes(appRuntime);
    const bootstrap = await routes.request("/api/chat/bootstrap");
    const snapshot = await bootstrap.json() as Record<string, unknown>;

    expect(bootstrap.status).toBe(200);
    expect(snapshot.channels).toEqual([expect.objectContaining({ name: "btc-research" })]);
    expect(snapshot).not.toHaveProperty("saved");
    expect(snapshot).not.toHaveProperty("pinned");
  });
});
