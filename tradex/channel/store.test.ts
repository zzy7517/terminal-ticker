import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ChatEventStore } from "../chat/events.js";
import { channelTarget } from "./domain.js";
import { ChannelStore } from "./store.js";

describe("ChannelStore", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  });

  function createStore(): ChannelStore {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tradex-channel-"));
    roots.push(root);
    return new ChannelStore(path.join(root, "chat.sqlite3"));
  }

  it("creates a Channel and appends Human messages with monotonic sequence and version", () => {
    const store = createStore();
    const channel = store.createChannel({ name: "btc-research", topic: "BTC research" });

    const first = store.appendMessage({ channelId: channel.id, authorId: "owner", content: "Start analysis" });
    const second = store.appendMessage({ channelId: channel.id, authorId: "owner", content: "Focus on liquidity" });

    expect(first).toEqual(expect.objectContaining({ channelSeq: 1, content: "Start analysis" }));
    expect(second).toEqual(expect.objectContaining({ channelSeq: 2, content: "Focus on liquidity" }));
    expect(store.getChannel(channel.id)?.version).toBe(2);
    expect(store.listMessages({ channelId: channel.id, limit: 1 })).toEqual({
      messages: [expect.objectContaining({ id: second.id, channelSeq: 2 })],
      nextBeforeSeq: 2,
    });
  });

  it("keeps reactions attached to the Channel message", () => {
    const store = createStore();
    const channel = store.createChannel({ name: "btc-research" });
    const root = store.appendMessage({ channelId: channel.id, authorId: "owner", content: "Initial thesis" });
    const detail = store.appendMessage({ channelId: channel.id, authorId: "owner", content: "Follow-up detail" });
    const reacted = store.addReaction({ channelId: channel.id, messageId: root.id, actorId: "owner", emoji: "👍" });

    expect(store.listMessages({ channelId: channel.id }).messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: root.id, content: "Initial thesis" }),
      expect.objectContaining({ id: detail.id, content: "Follow-up detail" }),
    ]));
    expect(reacted.reactions).toEqual([{ emoji: "👍", count: 1, reacted: true }]);

    const unreacted = store.removeReaction({ channelId: channel.id, messageId: root.id, actorId: "owner", emoji: "👍" });
    expect(unreacted.reactions).toEqual([]);
  });

  it("records recoverable generic events with monotonic global sequence", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tradex-channel-events-"));
    roots.push(root);
    const dbPath = path.join(root, "chat.sqlite3");
    const store = new ChannelStore(dbPath);
    const events = new ChatEventStore(dbPath);
    const channel = store.createChannel({ name: "btc-research" });
    const target = channelTarget(channel.id);
    const message = store.appendMessage({ channelId: channel.id, authorId: "owner", content: "Start" });
    store.addReaction({ channelId: channel.id, messageId: message.id, actorId: "owner", emoji: "👍" });

    const firstPage = events.list({ afterSeq: 0, limit: 2 });
    const secondPage = events.list({ afterSeq: firstPage.events.at(-1)!.seq, limit: 10 });

    expect(firstPage.events).toHaveLength(2);
    expect(secondPage.events).toEqual([
      expect.objectContaining({
        seq: 3,
        type: "reaction.added",
        target,
        entityType: "message",
        entityId: message.id,
      }),
    ]);
    expect(events.latestSeq()).toBe(3);
  });

  it("preserves unknown future message kinds without schema changes", () => {
    const store = createStore();
    const channel = store.createChannel({ name: "btc-research" });

    const message = store.appendMessage({
      channelId: channel.id,
      authorId: "owner",
      content: "Future entity",
      kind: "future-kind",
    });

    expect(message.kind).toBe("future-kind");
    expect(store.listMessages({ channelId: channel.id }).messages[0].kind).toBe("future-kind");
  });

  it("excludes Human-authored messages from unread counts", () => {
    const store = createStore();
    const channel = store.createChannel({ name: "btc-research" });
    store.appendMessage({ channelId: channel.id, authorId: "owner", content: "human ping" });
    store.appendAgentMessage({ channelId: channel.id, authorId: "cindy", content: "agent reply" });
    store.appendMessage({ channelId: channel.id, authorId: "owner", content: "human follow-up" });
    expect(store.countMessagesAfterSeq(channel.id, 0)).toBe(1);
    expect(store.countMessagesAfterSeq(channel.id, 1)).toBe(1);
    expect(store.countMessagesAfterSeq(channel.id, 2)).toBe(0);
  });
});
