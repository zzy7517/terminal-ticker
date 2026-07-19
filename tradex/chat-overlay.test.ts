import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { channelTarget, directMessageTarget } from "./channel/domain.js";
import { ChatOverlayStore } from "./chat-overlay.js";

describe("ChatOverlayStore", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  });

  function createStore(): ChatOverlayStore {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tradex-chat-overlay-"));
    roots.push(root);
    return new ChatOverlayStore(path.join(root, "chat.sqlite3"));
  }

  it("keeps Saved and Pinned references unambiguous across Chat target kinds", () => {
    const store = createStore();
    const channel = channelTarget("btc-research");
    const direct = directMessageTarget("dm-1");

    store.save({ actorId: "owner", target: channel, messageId: "message-1" });
    store.save({ actorId: "owner", target: direct, messageId: "message-1" });
    store.pin({ actorId: "owner", target: channel, messageId: "message-1" });

    expect(store.listSaved("owner")).toEqual([
      expect.objectContaining({ target: direct, messageId: "message-1" }),
      expect.objectContaining({ target: channel, messageId: "message-1" }),
    ]);
    expect(store.listPinned(channel)).toEqual([
      expect.objectContaining({ target: channel, messageId: "message-1" }),
    ]);

    store.unsave({ actorId: "owner", target: channel, messageId: "message-1" });
    store.unpin({ actorId: "owner", target: channel, messageId: "message-1" });
    expect(store.listSaved("owner")).toEqual([expect.objectContaining({ target: direct })]);
    expect(store.listPinned(channel)).toEqual([]);
  });
});
