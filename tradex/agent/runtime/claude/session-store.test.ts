import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ClaudeSessionStore } from "./session-store.js";

describe("Claude Session repository", () => {
  it("persists a Tradex projection separately from the native session id", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "tradex-claude-store-"));
    const store = new ClaudeSessionStore(root);
    const created = store.create({
      title: "BTC",
      snapshot: { agentId: "claude", agentName: "Claude", runtime: "claude-code", systemPrompt: "rules", provider: null, model: "opus", reasoningEffort: "high" },
    });
    store.appendMessage(created.id, { role: "user", content: "Analyze BTC" });
    store.setNativeSessionId(created.id, "11111111-1111-4111-8111-111111111111");
    store.appendMessage(created.id, { role: "assistant", content: "Done", metadata: { totalTokens: 10 } });

    const payload = store.payload(created.id);
    expect(payload?.session).toMatchObject({ id: created.id, runtime: "claude-code", nativeSessionId: "11111111-1111-4111-8111-111111111111" });
    expect(payload?.messages.map((message) => [message.role, message.content])).toEqual([["user", "Analyze BTC"], ["assistant", "Done"]]);
    expect(store.list()).toHaveLength(1);
  });
});
