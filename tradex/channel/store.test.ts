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

  it("keeps revisions, threads, and reactions attached to the Channel message", () => {
    const store = createStore();
    const channel = store.createChannel({ name: "btc-research" });
    const root = store.appendMessage({ channelId: channel.id, authorId: "owner", content: "Initial thesis" });

    const edited = store.editMessage({ channelId: channel.id, messageId: root.id, actorId: "owner", content: "Updated thesis" });
    const reply = store.appendMessage({ channelId: channel.id, authorId: "owner", content: "Thread detail", threadRootId: root.id });
    const reacted = store.addReaction({ channelId: channel.id, messageId: root.id, actorId: "owner", emoji: "👍" });

    expect(edited).toEqual(expect.objectContaining({ content: "Updated thesis", editedAtMs: expect.any(Number) }));
    expect(store.listRevisions({ channelId: channel.id, messageId: root.id })).toEqual([
      expect.objectContaining({ revision: 1, content: "Initial thesis", action: "edit" }),
    ]);
    expect(store.listThread({ channelId: channel.id, rootMessageId: root.id })).toEqual({
      root: expect.objectContaining({ id: root.id, replyCount: 1 }),
      replies: [expect.objectContaining({ id: reply.id, threadRootId: root.id })],
    });
    expect(reacted.reactions).toEqual([{ emoji: "👍", count: 1, reacted: true }]);

    const unreacted = store.removeReaction({ channelId: channel.id, messageId: root.id, actorId: "owner", emoji: "👍" });
    expect(unreacted.reactions).toEqual([]);
    const deleted = store.deleteMessage({ channelId: channel.id, messageId: reply.id, actorId: "owner" });
    expect(deleted).toEqual(expect.objectContaining({ content: "", deletedAtMs: expect.any(Number) }));
    expect(store.listRevisions({ channelId: channel.id, messageId: reply.id })).toEqual([
      expect.objectContaining({ content: "Thread detail", action: "delete" }),
    ]);
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
});
