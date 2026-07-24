import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentStore } from "../agent/agent_store.js";
import { ChannelStore } from "../channel/store.js";
import type { AppRuntime } from "../api/runtime.js";
import { createMessageToolRegistry } from "./message-tools.js";
import { InboxStore } from "./inbox-store.js";
import { MessageStore } from "./message-store.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function createRuntime() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tradex-msg-tools-"));
  roots.push(root);
  const dbPath = path.join(root, "chat.sqlite3");
  const agentStore = new AgentStore(path.join(root, "agents"));
  agentStore.create({
    id: "alpha",
    name: "Alpha",
    description: "",
    systemPrompt: "x",
    runtime: "pi",
    provider: "openai",
    model: "gpt-5.4",
    reasoningEffort: null,
  });
  const channelStore = new ChannelStore(dbPath);
  const messageStore = new MessageStore(dbPath);
  const inboxStore = new InboxStore(dbPath);
  const runtime = {
    agentStore,
    channelStore,
    messageStore,
    inboxStore,
    agentCoordinator: { notify: () => undefined, resetChain: () => undefined },
    config: {
      channels: {
        maxActiveAgents: 3,
        maxAgents: 20,
        maxActivationHops: 16,
        activationDebounceMs: 500,
        retryMaxSeconds: 300,
      },
    },
  } as unknown as AppRuntime;
  return { runtime, channelStore, messageStore };
}

describe("createMessageToolRegistry", () => {
  it("exposes reaction and around-capable message tools for both runtimes", () => {
    const { runtime } = createRuntime();
    const registry = createMessageToolRegistry(runtime, "alpha");
    const names = registry.listToolsForExternalRuntime("claude-code").map((tool) => tool.name);
    expect(names).toEqual(expect.arrayContaining([
      "message_check",
      "message_read",
      "message_send",
      "message_add_reaction",
      "message_remove_reaction",
      "memory_apply_retention",
    ]));
    expect(names).not.toContain("open_exchange_trade");
  });

  it("reads around a channel message id from the target suffix", async () => {
    const { runtime, channelStore } = createRuntime();
    const channel = channelStore.createChannel({ name: "btc-research" });
    channelStore.addMember({ channelId: channel.id, subjectType: "agent", subjectId: "alpha" });
    channelStore.appendMessage({ channelId: channel.id, authorId: "owner", content: "one" });
    const mid = channelStore.appendMessage({ channelId: channel.id, authorId: "owner", content: "two" });
    channelStore.appendMessage({ channelId: channel.id, authorId: "owner", content: "three" });
    const registry = createMessageToolRegistry(runtime, "alpha");
    const tool = registry.get("message_read");
    expect(tool).toBeTruthy();
    const raw = await tool!.execute({ target: `#btc-research:${mid.id}`, limit: 5 });
    const payload = JSON.parse(String(raw));
    expect(payload.aroundMessageId).toBe(mid.id);
    expect(payload.messages.map((message: { content: string }) => message.content)).toEqual([
      "one",
      "two",
      "three",
    ]);
  });
});
