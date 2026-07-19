import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentStore } from "../agent/agent_store.js";
import { ChannelStore } from "../channel/store.js";
import type { AppRuntime } from "../api/runtime.js";
import { appendChannelMessageAndNotify, resolveMentionedAgentIds } from "./dispatch.js";
import { InboxStore } from "./inbox-store.js";
import { MessageStore } from "./message-store.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("dispatch mentions", () => {
  it("wakes mentioned Agents with reason mention", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tradex-dispatch-"));
    roots.push(root);
    const dbPath = path.join(root, "chat.sqlite3");
    const agentStore = new AgentStore(root);
    agentStore.create({
      id: "alpha",
      name: "Alpha Bot",
      description: "",
      systemPrompt: "x",
      runtime: "pi",
      provider: "openai",
      model: "gpt-5.4",
      reasoningEffort: null,
    });
    agentStore.create({
      id: "beta",
      name: "Beta",
      description: "",
      systemPrompt: "x",
      runtime: "pi",
      provider: "openai",
      model: "gpt-5.4",
      reasoningEffort: null,
    });
    const channelStore = new ChannelStore(dbPath);
    const inboxStore = new InboxStore(dbPath);
    const messageStore = new MessageStore(dbPath);
    const woken: string[] = [];
    const runtime = {
      agentStore,
      channelStore,
      inboxStore,
      messageStore,
      agentCoordinator: { notify: (agentId: string) => woken.push(agentId), resetChain: () => undefined },
    } as unknown as AppRuntime;

    const channel = channelStore.createChannel({ name: "room", topic: "" });
    channelStore.addMember({ channelId: channel.id, subjectType: "agent", subjectId: "alpha" });
    channelStore.addMember({ channelId: channel.id, subjectType: "agent", subjectId: "beta" });

    expect(resolveMentionedAgentIds(runtime, channel.id, "hey @alpha check this")).toEqual(["alpha"]);

    appendChannelMessageAndNotify(runtime, {
      channelId: channel.id,
      authorType: "human",
      authorId: "owner",
      content: "please help @beta",
    });

    const alpha = inboxStore.listPending("alpha");
    const beta = inboxStore.listPending("beta");
    expect(alpha[0]?.reason).toBe("joined-channel");
    expect(beta[0]?.reason).toBe("mention");
    expect(woken.sort()).toEqual(["alpha", "beta"]);
  });
});
