import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
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
});
