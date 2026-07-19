import { describe, expect, it } from "vitest";
import {
  ACTIVATION_WAKE_MARKER,
  MESSAGE_OPERATING_INSTRUCTIONS,
  buildWakePrompt,
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
    expect(wake).not.toContain("Prefer silence over noise");
    expect(isActivationWakeContent(wake)).toBe(true);
  });

  it("detects legacy ops-in-user-prompt imports", () => {
    const legacy = `${MESSAGE_OPERATING_INSTRUCTIONS}\n\nYou have unread messages across 1 target.`;
    expect(isActivationWakeContent(legacy)).toBe(true);
    expect(isActivationWakeContent("hello from owner")).toBe(false);
  });
});
