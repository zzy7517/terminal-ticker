import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentStore } from "../agent/agent-store.js";

import { AgentContextStore } from "../agent/context-store.js";
import { ChannelStore } from "../channel/store.js";
import { channelTarget } from "./target.js";
import type { AppRuntime } from "../api/runtime.js";
import { InboxStore } from "./inbox-store.js";
import { MessageStore } from "./message-store.js";

vi.mock("./runtime.js", () => ({
  startMessageActivation: vi.fn().mockResolvedValue(undefined),
}));

const { AgentCoordinator } = await import("./coordinator.js");
const { startMessageActivation } = await import("./runtime.js");

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  vi.clearAllMocks();
});

function harness(maxActivationHops = 2) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tradex-coord-"));
  roots.push(root);
  const dbPath = path.join(root, "chat.sqlite3");
  const agentStore = new AgentStore(root);
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
  const inboxStore = new InboxStore(dbPath);
  const messageStore = new MessageStore(dbPath);
  const runtime = {
    agentStore,
    agentContexts: new AgentContextStore(dbPath),
    channelStore,
    inboxStore,
    messageStore,
    activeAgents: new Map(),
    config: { channels: { maxActivationHops } },
    agentCoordinator: null as InstanceType<typeof AgentCoordinator> | null,
  } as unknown as AppRuntime;
  const coordinator = new AgentCoordinator(runtime, 0);
  runtime.agentCoordinator = coordinator;
  return { runtime, coordinator, channelStore, inboxStore };
}

describe("AgentCoordinator retry storm", () => {
  it("does not immediately re-activate after failure; only backoff retries", async () => {
    vi.useFakeTimers();
    vi.mocked(startMessageActivation).mockRejectedValue(new Error("402 spending limit"));
    const { coordinator, channelStore, inboxStore } = harness(8);
    const channel = channelStore.createChannel({ name: "retry", topic: "" });
    channelStore.addMember({ channelId: channel.id, subjectType: "agent", subjectId: "alpha" });
    const target = channelTarget(channel.id);
    const message = channelStore.appendAgentMessage({
      channelId: channel.id,
      authorId: "other",
      content: "wake",
    });
    inboxStore.notify({
      agentId: "alpha",
      target,
      messageId: message.id,
      reason: "joined-channel",
    });

    coordinator.start();
    coordinator.notify("alpha");
    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();
    expect(vi.mocked(startMessageActivation).mock.calls.length).toBe(1);

    // finally must not fire a second activation immediately
    await vi.advanceTimersByTimeAsync(100);
    expect(vi.mocked(startMessageActivation).mock.calls.length).toBe(1);

    // first backoff is 2s (attempt=1 → 1000*2^1)
    await vi.advanceTimersByTimeAsync(2_000);
    await Promise.resolve();
    expect(vi.mocked(startMessageActivation).mock.calls.length).toBe(2);

    coordinator.stop();
    vi.useRealTimers();
    vi.mocked(startMessageActivation).mockResolvedValue(undefined);
  });
});

describe("AgentCoordinator causal chain", () => {
  it("pauses a channel chain after maxActivationHops and writes a system notice", async () => {
    const { coordinator, channelStore, inboxStore } = harness(2);
    const channel = channelStore.createChannel({ name: "loop", topic: "" });
    channelStore.addMember({ channelId: channel.id, subjectType: "agent", subjectId: "alpha" });
    const target = channelTarget(channel.id);

    coordinator.start();
    coordinator.resetChain(target);

    for (let i = 0; i < 3; i += 1) {
      const message = channelStore.appendAgentMessage({
        channelId: channel.id,
        authorId: "other",
        content: `ping-${i}`,
      });
      inboxStore.notify({
        agentId: "alpha",
        target,
        messageId: message.id,
        reason: "joined-channel",
      });
      coordinator.notify("alpha");
      await vi.waitFor(() => {
        expect(vi.mocked(startMessageActivation).mock.calls.length).toBeGreaterThanOrEqual(Math.min(i + 1, 2));
      });
    }

    await vi.waitFor(() => {
      const notices = channelStore.listMessages({ channelId: channel.id, limit: 20 }).messages
        .filter((message) => message.authorType === "system");
      expect(notices.length).toBeGreaterThanOrEqual(1);
      expect(notices[0]?.content).toContain("Causal activation chain paused");
    });

    expect(vi.mocked(startMessageActivation).mock.calls.length).toBe(2);
    const deferred = inboxStore.listForAgent("alpha").filter((item) => item.status === "deferred");
    expect(deferred.length).toBeGreaterThanOrEqual(1);
    coordinator.stop();
  });
});
