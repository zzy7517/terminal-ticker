import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MessageStore } from "./message-store.js";
import { parseMessageTarget } from "./message-target.js";

describe("MessageStore", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  });

  function createStore(): MessageStore {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tradex-message-"));
    roots.push(root);
    return new MessageStore(path.join(root, "chat.sqlite3"));
  }

  it("keeps exactly one Human-Agent Direct Message per Agent", () => {
    const store = createStore();
    const first = store.ensureHumanAgentDm("cindy");
    const second = store.ensureHumanAgentDm("cindy");
    expect(second.id).toBe(first.id);
    expect(store.humanAgentDmForAgent("cindy")?.id).toBe(first.id);
  });

  it("appends DM messages with stable ids and monotonic sequence", () => {
    const store = createStore();
    const dm = store.ensureHumanAgentDm("cindy");
    const first = store.appendMessage({
      directMessageId: dm.id,
      authorType: "human",
      authorId: "owner",
      content: "hello",
    });
    const second = store.appendMessage({
      directMessageId: dm.id,
      authorType: "agent",
      authorId: "cindy",
      content: "hi",
    });
    expect(first.dmSeq).toBe(1);
    expect(second.dmSeq).toBe(2);
    expect(store.listMessages({ directMessageId: dm.id }).messages).toEqual([
      expect.objectContaining({ id: second.id }),
      expect.objectContaining({ id: first.id }),
    ]);
  });

  it("imports legacy session messages idempotently", () => {
    const store = createStore();
    const dm = store.ensureHumanAgentDm("cindy");
    const once = store.appendMessage({
      directMessageId: dm.id,
      authorType: "human",
      authorId: "owner",
      content: "old",
      importKey: "session-1:1",
      createdAtMs: 100,
    });
    const twice = store.appendMessage({
      directMessageId: dm.id,
      authorType: "human",
      authorId: "owner",
      content: "old",
      importKey: "session-1:1",
      createdAtMs: 100,
    });
    expect(twice.id).toBe(once.id);
    expect(store.listMessages({ directMessageId: dm.id }).messages).toHaveLength(1);
  });

  it("lists Human-Agent and Agent-Agent conversations for an Agent", () => {
    const store = createStore();
    const humanDm = store.ensureHumanAgentDm("cindy");
    const peerDm = store.ensureAgentAgentDm("cindy", "bob");
    store.ensureHumanAgentDm("bob");
    const listed = store.listConversationsForAgent("cindy");
    expect(listed.map((item) => item.id).sort()).toEqual([humanDm.id, peerDm.id].sort());
  });

  it("excludes Human-authored messages from unread counts", () => {
    const store = createStore();
    const dm = store.ensureHumanAgentDm("cindy");
    store.appendMessage({
      directMessageId: dm.id,
      authorType: "human",
      authorId: "owner",
      content: "hello",
    });
    store.appendMessage({
      directMessageId: dm.id,
      authorType: "agent",
      authorId: "cindy",
      content: "hi",
    });
    store.appendMessage({
      directMessageId: dm.id,
      authorType: "human",
      authorId: "owner",
      content: "thanks",
    });
    expect(store.countMessagesAfterSeq(dm.id, 0)).toBe(1);
    expect(store.countMessagesAfterSeq(dm.id, 1)).toBe(1);
    expect(store.countMessagesAfterSeq(dm.id, 2)).toBe(0);
  });
});

describe("parseMessageTarget", () => {
  it("resolves channel and dm targets through the trusted resolver", () => {
    const parsed = parseMessageTarget("dm:@cindy", { type: "human", id: "owner" }, {
      resolveChannelName: () => "channel-1",
      resolveDirectMessage: () => "dm-1",
    });
    expect(parsed).toEqual({
      chatTarget: { kind: "direct-message", directMessageId: "dm-1" },
      messageId: null,
      raw: "dm:@cindy",
    });
    expect(parseMessageTarget("#btc-research:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", { type: "agent", id: "cindy" }, {
      resolveChannelName: (name) => name === "btc-research" ? "channel-1" : null,
      resolveDirectMessage: () => null,
    }).chatTarget).toEqual({ kind: "channel", channelId: "channel-1" });
  });
});
