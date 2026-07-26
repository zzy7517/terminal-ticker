// 验证公共 Session 流编排器的结算、取消和清理行为。
import { describe, expect, it } from "vitest";
import type { ActiveRuntimeRun, RuntimeEvent } from "../agent/runtime/types.js";
import { abortSessionRun, streamSessionRun, withSessionRunReservation } from "./session-stream.js";
import type { AppRuntime } from "./runtime.js";

// 创建仅包含运行状态容器的测试 AppRuntime。
function fakeRuntime(): AppRuntime {
  return {
    activeAgents: new Map(),
    lockedAgentSessions: new Set(),
  } as unknown as AppRuntime;
}

// 创建按顺序发送指定事件的测试 Runtime run。
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

// 创建由测试直接控制结果和中止行为的 Runtime run。
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
        };
      },
      cleanup() { order.push("cleanup"); },
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

  it("holds a reservation during async preflight and releases an early response", async () => {
    const runtime = fakeRuntime();
    let continuePreflight!: () => void;
    let preflightStarted!: () => void;
    const started = new Promise<void>((resolve) => { preflightStarted = resolve; });
    const gate = new Promise<void>((resolve) => { continuePreflight = resolve; });
    const pending = withSessionRunReservation({
      runtime,
      sessionId: "session-1",
      async prepare() {
        preflightStarted();
        await gate;
        return Response.json({ detail: "not found" }, { status: 404 });
      },
    });

    await started;
    expect(runtime.lockedAgentSessions.has("session-1")).toBe(true);
    const duplicate = streamSessionRun({
      runtime,
      sessionId: "session-1",
      prepare: async () => { throw new Error("unused"); },
    });
    expect(duplicate.status).toBe(409);

    continuePreflight();
    expect((await pending).status).toBe(404);
    expect(runtime.lockedAgentSessions.has("session-1")).toBe(false);
  });

  it("keeps a transferred reservation until terminal cleanup", async () => {
    const runtime = fakeRuntime();
    let finish!: (result: { output: string; error: null }) => void;
    const result = new Promise<{ output: string; error: null }>((resolve) => { finish = resolve; });
    let cleaned = false;
    const response = await withSessionRunReservation({
      runtime,
      sessionId: "session-1",
      async prepare(reservation) {
        return streamSessionRun({
          runtime,
          sessionId: "session-1",
          reservation,
          prepare: async () => ({
            run: controlledRun(result),
            onEvent() {},
            complete() {},
            fail() {},
          }),
          cleanup() { cleaned = true; },
        });
      },
    });

    expect(response.status).toBe(200);
    expect(runtime.lockedAgentSessions.has("session-1")).toBe(true);
    finish({ output: "done", error: null });
    await response.text();
    expect(cleaned).toBe(true);
    expect(runtime.lockedAgentSessions.has("session-1")).toBe(false);
  });

  it("routes listener failures through fail instead of complete", async () => {
    const runtime = fakeRuntime();
    const order: string[] = [];
    let failure: unknown;
    const response = streamSessionRun({
      runtime,
      sessionId: "session-1",
      async prepare() {
        return {
          run: controlledRun(Promise.resolve({ output: "", error: "write failed", errorCode: "runtime_listener_failed" })),
          onEvent() {},
          complete() { order.push("complete"); },
          fail(error) { order.push("fail"); failure = error; },
        };
      },
    });

    await response.text();
    expect(order).toEqual(["fail"]);
    expect(failure).toMatchObject({
      name: "SessionRunError",
      code: "runtime_listener_failed",
      message: "write failed",
    });
  });

  it("cleans up resources acquired before preparation fails", async () => {
    const runtime = fakeRuntime();
    const order: string[] = [];
    const response = streamSessionRun({
      runtime,
      sessionId: "session-1",
      async prepare() {
        order.push("prepare");
        throw new Error("prepare failed");
      },
      onPrepareFailure() { order.push("prepare-failure"); },
      cleanup() { order.push("cleanup"); },
    });

    await response.text();
    expect(order).toEqual(["prepare", "prepare-failure", "cleanup"]);
    expect(runtime.activeAgents.size).toBe(0);
    expect(runtime.lockedAgentSessions.size).toBe(0);
  });

  it("aborts a run prepared after the client disconnects", async () => {
    const runtime = fakeRuntime();
    let resolvePrepare!: (run: ActiveRuntimeRun) => void;
    const prepared = new Promise<ActiveRuntimeRun>((resolve) => { resolvePrepare = resolve; });
    let aborted = false;
    let completed = false;
    const response = streamSessionRun({
      runtime,
      sessionId: "session-1",
      async prepare() {
        const run = await prepared;
        return {
          run,
          onEvent() {},
          complete(result) { completed = result.errorCode === "aborted"; },
          fail() {},
        };
      },
    });
    const reader = response.body!.getReader();
    await reader.cancel();
    resolvePrepare(controlledRun(
      Promise.resolve({ output: "", error: "Run aborted", errorCode: "aborted" }),
      () => { aborted = true; },
    ));
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(aborted).toBe(true);
    expect(completed).toBe(true);
    expect(runtime.activeAgents.size).toBe(0);
    expect(runtime.lockedAgentSessions.size).toBe(0);
  });

  it("aborts a cooperative prepare through the Session reservation", async () => {
    const runtime = fakeRuntime();
    let prepareStarted!: () => void;
    const started = new Promise<void>((resolve) => { prepareStarted = resolve; });
    const response = streamSessionRun({
      runtime,
      sessionId: "session-1",
      async prepare(signal) {
        prepareStarted();
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
        throw new Error("unreachable");
      },
    });

    await started;
    await expect(abortSessionRun(runtime, "session-1")).resolves.toBe(true);
    const body = await response.text();

    expect(runtime.activeAgents.size).toBe(0);
    expect(runtime.lockedAgentSessions.size).toBe(0);
    expect(body).toContain('"errorCode":"aborted"');
    expect(body).not.toContain('"errorCode":"runtime_failure"');
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
        };
      },
      cleanup() { throw new Error("cleanup failed"); },
    });

    await response.text();
    expect(runtime.activeAgents.size).toBe(0);
    expect(runtime.lockedAgentSessions.size).toBe(0);
  });
});
