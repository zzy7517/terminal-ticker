import { describe, expect, it, vi } from "vitest";
import type { AppRuntime } from "../api/runtime.js";
import { applyAgentLifecycleReset } from "./runtime.js";

describe("applyAgentLifecycleReset", () => {
  it("restart keeps the active session id", async () => {
    const notify = vi.fn();
    const stopCurrentRun = vi.fn(async () => undefined);
    const runtime = {
      agentStore: { get: () => ({ id: "alpha", runtime: "pi" }) },
      agentCoordinator: { stopCurrentRun, notify },
      agentContextManager: {
        get: () => ({ activeSessionId: "session-keep" }),
        updateStatus: vi.fn(),
      },
    } as unknown as AppRuntime;

    const result = await applyAgentLifecycleReset(runtime, "alpha", "restart");
    expect(stopCurrentRun).toHaveBeenCalledWith("alpha");
    expect(result).toEqual({ mode: "restart", sessionId: "session-keep" });
    expect(notify).toHaveBeenCalledWith("alpha");
  });
});
