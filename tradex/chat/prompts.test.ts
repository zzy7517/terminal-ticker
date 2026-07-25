import { describe, expect, it } from "vitest";
import {
  ACTIVATION_WAKE_MARKER,
  MESSAGE_OPERATING_INSTRUCTIONS,
  buildWakePrompt,
  buildSkillAwareWakePrompt,
  isActivationWakeContent,
} from "./prompts.js";
import type { InboxItem } from "./inbox-store.js";

describe("activation wake prompts", () => {
  it("marks short wakes and keeps ops out of the user prompt", () => {
    const pending = [{
      id: "i1",
      agentId: "alpha",
      target: { kind: "channel", channelId: "c1" },
      firstMessageId: "m1",
      latestMessageId: "m2",
      reason: "joined-channel",
      status: "pending",
      availableAtMs: 0,
      createdAtMs: 0,
    }] satisfies InboxItem[];
    const wake = buildWakePrompt(pending);
    expect(wake.startsWith(ACTIVATION_WAKE_MARKER)).toBe(true);
    expect(wake).toContain("channel:c1");
    expect(wake).toContain("tradex tool call message_check");
    expect(wake).not.toContain("Prefer silence over noise");
    expect(isActivationWakeContent(wake)).toBe(true);
  });

  it("prepends selected Skill instructions while keeping Human message bodies out of the wake", () => {
    const pendingWithSkill = [{
      id: "i1",
      agentId: "alpha",
      target: { kind: "direct-message", directMessageId: "dm1" },
      firstMessageId: "m1",
      latestMessageId: "m1",
      reason: "dm",
      status: "pending",
      availableAtMs: 0,
      createdAtMs: 0,
      skillNames: ["think"],
    }] satisfies InboxItem[];
    const wake = buildSkillAwareWakePrompt(
      pendingWithSkill,
      "<skill>\n<name>think</name>\nComplete instructions\n</skill>",
    );
    expect(wake).toContain("<name>think</name>");
    expect(wake).toContain("Complete instructions");
    expect(wake).toContain(ACTIVATION_WAKE_MARKER);
    expect(wake).not.toContain("Human secret message body");
  });

  it("tells agents to use the session tradex CLI rather than MCP", () => {
    expect(MESSAGE_OPERATING_INSTRUCTIONS).toContain("tradex tool call message_check");
    expect(MESSAGE_OPERATING_INSTRUCTIONS).toContain("Do not search MCP catalogs");
  });

  it("detects legacy ops-in-user-prompt imports", () => {
    const legacy = `${MESSAGE_OPERATING_INSTRUCTIONS}\n\nYou have unread messages across 1 target.`;
    expect(isActivationWakeContent(legacy)).toBe(true);
    expect(isActivationWakeContent("hello from owner")).toBe(false);
  });
});
