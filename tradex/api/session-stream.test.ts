import { describe, expect, it } from "vitest";
import type { ActiveRuntimeRun, RuntimeEvent } from "../agent/runtime/types.js";
import { streamSessionRun } from "./session-stream.js";
import type { AppRuntime } from "./runtime.js";

function fakeRuntime(): AppRuntime {
  return {
    activeAgents: new Map(),
    lockedAgentSessions: new Set(),
  } as unknown as AppRuntime;
}

function fakeRun(events: RuntimeEvent[]): ActiveRuntimeRun {
  let listener: ((event: RuntimeEvent, signal: AbortSignal) => void | Promise<void>) | null = null;
  const signal = new AbortController().signal;
  return {
    runtime: "pi",
    capabilities: { streaming: true, abort: true, resume: true, imageInput: true, toolProgress: true },
    subscribe(next) { listener = next; return () => { listener = null; }; },
    result: new Promise((resolve) => {
      setTimeout(() => {
        void (async () => {
          for (const event of events) await listener?.(event, signal);
          resolve({ output: "done", error: null });
        })();
      }, 0);
    }),
    abort() {},
  };
}

function controlledRun(result: ActiveRuntimeRun["result"], abort: () => void = () => {}): ActiveRuntimeRun {
  return {
    runtime: "pi",
    capabilities: { streaming: true, abort: true, resume: true, imageInput: true, toolProgress: true },
    subscribe() { return () => {}; },
    result,
    abort,
  };
}

describe("Session stream orchestrator", () => {
  it("waits for event persistence before completion and releases active state", async () => {
    const runtime = fakeRuntime();
    const order: string[] = [];
    const response = streamSessionRun({
      runtime,
      sessionId: "session-1",
      async prepare() {
        return {
          run: fakeRun([{ type: "run-start" }, { type: "run-end", result: "done", status: "completed" }]),
          async onEvent(event) {
            await Promise.resolve();
            order.push(event.type);
          },
          complete(_result, send) {
            order.push("complete");
            send({ type: "agent_end", error: null });
          },
          fail() { order.push("fail"); },
          cleanup() { order.push("cleanup"); },
        };
      },
    });

    expect(response.status).toBe(200);
    await response.text();
    expect(order).toEqual(["run-start", "run-end", "complete", "cleanup"]);
    expect(runtime.activeAgents.size).toBe(0);
    expect(runtime.lockedAgentSessions.size).toBe(0);
  });

  it("rejects a second run while the Session is locked", async () => {
    const runtime = fakeRuntime();
    runtime.lockedAgentSessions.add("session-1");
    const response = streamSessionRun({ runtime, sessionId: "session-1", prepare: async () => { throw new Error("unused"); } });
    expect(response.status).toBe(409);
  });

  it("routes listener failures through fail instead of complete", async () => {
    const runtime = fakeRuntime();
    const order: string[] = [];
    const response = streamSessionRun({
      runtime,
      sessionId: "session-1",
      async prepare() {
        return {
          run: controlledRun(Promise.resolve({ output: "", error: "write failed", errorCode: "runtime_listener_failed" })),
          onEvent() {},
          complete() { order.push("complete"); },
          fail() { order.push("fail"); },
        };
      },
    });

    await response.text();
    expect(order).toEqual(["fail"]);
  });

  it("aborts a run prepared after the client disconnects", async () => {
    const runtime = fakeRuntime();
    let resolvePrepare!: (run: ActiveRuntimeRun) => void;
    const prepared = new Promise<ActiveRuntimeRun>((resolve) => { resolvePrepare = resolve; });
    let aborted = false;
    const response = streamSessionRun({
      runtime,
      sessionId: "session-1",
      async prepare() {
        const run = await prepared;
        return { run, onEvent() {}, complete() {}, fail() {} };
      },
    });
    const reader = response.body!.getReader();
    await reader.cancel();
    resolvePrepare(controlledRun(Promise.resolve({ output: "", error: null }), () => { aborted = true; }));
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(aborted).toBe(true);
    expect(runtime.activeAgents.size).toBe(0);
    expect(runtime.lockedAgentSessions.size).toBe(0);
  });

  it("releases Session state when cleanup fails", async () => {
    const runtime = fakeRuntime();
    const response = streamSessionRun({
      runtime,
      sessionId: "session-1",
      async prepare() {
        return {
          run: controlledRun(Promise.resolve({ output: "", error: null })),
          onEvent() {},
          complete() {},
          fail() {},
          cleanup() { throw new Error("cleanup failed"); },
        };
      },
    });

    await response.text();
    expect(runtime.activeAgents.size).toBe(0);
    expect(runtime.lockedAgentSessions.size).toBe(0);
  });
});
