import { describe, expect, it, vi } from "vitest";
import { PiActiveRuntimeRun, type PiAgentRuntime } from "./runtime.js";

function fakeAgent(prompt: PiAgentRuntime["prompt"], abort: PiAgentRuntime["abort"] = vi.fn()) {
  return {
    messages: [],
    subscribe: vi.fn(() => () => {}),
    prompt: vi.fn(prompt),
    abort: vi.fn(abort),
    dispose: vi.fn(),
  } satisfies PiAgentRuntime;
}

describe("PiActiveRuntimeRun", () => {
  it("disposes the Pi session after a successful run", async () => {
    const agent = fakeAgent(async () => {});
    const run = new PiActiveRuntimeRun(agent, "hello");

    await expect(run.result).resolves.toMatchObject({ output: "", error: null });
    expect(agent.dispose).toHaveBeenCalledOnce();
  });

  it("disposes the Pi session after a failed run", async () => {
    const agent = fakeAgent(async () => {
      throw new Error("provider failed");
    });
    const run = new PiActiveRuntimeRun(agent, "hello");

    await expect(run.result).resolves.toMatchObject({
      error: "provider failed",
      errorCode: "runtime_failure",
    });
    expect(agent.dispose).toHaveBeenCalledOnce();
  });

  it("waits for an aborted run to settle before disposing the Pi session", async () => {
    let rejectPrompt: ((error: Error) => void) | undefined;
    const agent = fakeAgent(
      () => new Promise<void>((_resolve, reject) => { rejectPrompt = reject; }),
      () => { rejectPrompt?.(new Error("cancelled")); },
    );
    const run = new PiActiveRuntimeRun(agent, "hello");
    await Promise.resolve();

    await run.abort();
    await expect(run.result).resolves.toMatchObject({ errorCode: "aborted" });
    expect(agent.dispose).toHaveBeenCalledOnce();
  });
});
