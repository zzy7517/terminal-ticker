import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CLAUDE_CODE_CAPABILITIES } from "../agent/runtime/capabilities.js";
import {
  ExternalSessionStore,
  type ExternalSessionStorePort,
  type ExternalSessionSnapshot,
} from "../agent/runtime/external-session-store.js";
import type { ActiveRuntimeRun } from "../agent/runtime/types.js";
import { streamExternalCliSession } from "./external-cli-session-stream.js";
import { createExternalCliTurn } from "./external-cli-turn.js";
import type { AppRuntime } from "./runtime.js";
import { SessionRunError, streamSessionRun } from "./session-stream.js";

const roots: string[] = [];

afterEach(() => {
  vi.unstubAllEnvs();
  roots.splice(0).forEach((root) => fs.rmSync(root, { recursive: true, force: true }));
});

describe("External CLI turn", () => {
  it("owns attachments, journal projection, and terminal SSE for an external Runtime", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tradex-external-turn-"));
    roots.push(root);
    const store = new ExternalSessionStore<"claude-code", ExternalSessionSnapshot<"claude-code">>({
      root,
      runtime: "claude-code",
      runtimeLabel: "Test Claude",
      capabilities: CLAUDE_CODE_CAPABILITIES,
    });
    const metadata = store.create({
      title: "Test Session",
      snapshot: {
        runtime: "claude-code",
        systemPrompt: "",
        provider: null,
        model: "sonnet",
        reasoningEffort: "high",
      },
    });
    const projected = {
      session: { id: metadata.id },
      history: { sessions: [{ id: metadata.id }] },
    };
    const turn = createExternalCliTurn({
      runtime: {} as AppRuntime,
      sessionId: metadata.id,
      message: "Inspect this",
      requestImages: [{ type: "image", data: "aGVsbG8=", mimeType: "image/png" }],
      sessionStore: store,
      model: metadata.snapshot.model,
      usage: "reported",
      projectSessionUpdate: async () => projected,
      errorCode: () => null,
    });
    const abort = vi.fn();
    const run = {
      runtime: "claude-code",
      capabilities: CLAUDE_CODE_CAPABILITIES,
      nativeSessionId: "native-1",
      result: Promise.resolve({ output: "done", error: null }),
      subscribe: () => () => undefined,
      abort,
    } satisfies ActiveRuntimeRun;
    let preparedPrompt = "";

    await expect(turn.prepare(async ({ prompt }) => {
      preparedPrompt = prompt;
      return run;
    })).resolves.toBe(run);

    expect(preparedPrompt).toContain("Inspect this");
    expect(preparedPrompt).toContain("attachments/");
    expect(store.messages(metadata.id)).toEqual([
      expect.objectContaining({
        role: "user",
        content: "Inspect this",
        metadata: {
          images: [expect.objectContaining({ mimeType: "image/png", filename: expect.stringMatching(/\.png$/) })],
        },
      }),
    ]);
    expect(store.getMetadata(metadata.id)?.nativeSessionId).toBe("native-1");

    const sent: Array<Record<string, unknown>> = [];
    turn.onEvent({
      type: "message-update",
      message: { id: "assistant-1", role: "assistant", content: [], timestamp: Date.now() },
      delta: "analysis complete",
    }, (event) => sent.push(event));
    turn.onEvent({
      type: "usage",
      model: "sonnet",
      input: 10,
      output: 4,
      cacheRead: 2,
      cacheWrite: 1,
    }, (event) => sent.push(event));
    await turn.complete({ output: "analysis complete", error: null }, (event) => sent.push(event));

    expect(store.messages(metadata.id).at(-1)).toMatchObject({
      role: "assistant",
      content: "analysis complete",
      metadata: {
        model: "sonnet",
        promptTokens: 10,
        completionTokens: 4,
        cacheRead: 2,
        cacheWrite: 1,
        totalTokens: 17,
      },
    });
    expect(store.payload(metadata.id)?.messages[0]).toMatchObject({
      role: "user",
      metadata: {
        images: [{ mimeType: "image/png", data: "aGVsbG8=" }],
      },
    });
    expect(sent.map((event) => event.type)).toEqual([
      "message_start",
      "message_update",
      "message_end",
      "session_update",
      "agent_end",
    ]);
    expect(sent.at(-2)).toMatchObject({ type: "session_update", ...projected });
    expect(abort).not.toHaveBeenCalled();
  });

  it("does not persist an attachment preflight failure when failed-turn persistence is disabled", async () => {
    const { root, store, metadata } = createStore();
    const failingStore: ExternalSessionStorePort<"claude-code"> = {
      getMetadata: store.getMetadata.bind(store),
      sessionDir: () => path.join(root, "missing-session-directory"),
      writeAttachment: () => { throw new Error("ENOENT: missing attachment directory"); },
      beginRun: store.beginRun.bind(store),
      endRun: store.endRun.bind(store),
      appendMessage: store.appendMessage.bind(store),
      setNativeSessionId: store.setNativeSessionId.bind(store),
    };
    const turn = createExternalCliTurn({
      runtime: {} as AppRuntime,
      sessionId: metadata.id,
      message: "Inspect this",
      requestImages: [{ type: "image", data: "aGVsbG8=", mimeType: "image/png" }],
      sessionStore: failingStore,
      model: metadata.snapshot.model,
      usage: "reported",
      persistFailedTurn: false,
      errorCode: () => null,
    });
    const start = vi.fn<Parameters<typeof turn.prepare>[0]>();

    await expect(turn.prepare(start)).rejects.toThrow(/ENOENT/);

    expect(start).not.toHaveBeenCalled();
    expect(store.getMetadata(metadata.id)?.lastRun).toBeNull();
    expect(store.messages(metadata.id)).toEqual([]);
  });

  it("does not write an attachment through a redirected attachment directory", async () => {
    const { root, store, metadata } = createStore();
    const external = fs.mkdtempSync(path.join(os.tmpdir(), "tradex-external-attachment-"));
    roots.push(external);
    const attachments = path.join(store.sessionDir(metadata.id), "attachments");
    fs.rmSync(attachments, { recursive: true });
    fs.symlinkSync(external, attachments, "dir");
    const turn = createExternalCliTurn({
      runtime: {} as AppRuntime,
      sessionId: metadata.id,
      message: "Inspect this",
      requestImages: [{ type: "image", data: "aGVsbG8=", mimeType: "image/png" }],
      sessionStore: store,
      model: metadata.snapshot.model,
      usage: "reported",
      errorCode: () => null,
    });
    const start = vi.fn<Parameters<typeof turn.prepare>[0]>();

    await expect(turn.prepare(start)).rejects.toThrow("attachment directory");

    expect(start).not.toHaveBeenCalled();
    expect(fs.readdirSync(external)).toEqual([]);
    expect(fs.existsSync(root)).toBe(true);
  });

  it("does not persist provider preflight failure when failed-turn persistence is disabled", async () => {
    const { root, store, metadata } = createStore();
    vi.stubEnv("TRADEX_CLAUDE_PATH", path.join(root, "missing-claude"));
    const runtime = {
      claudeSessions: store,
      lockedAgentSessions: new Set<string>(),
      activeAgents: new Map(),
    } as unknown as AppRuntime;

    const response = await streamExternalCliSession("claude-code", {
      runtime,
      requestUrl: "http://127.0.0.1:8765/api/agent/sessions/id/messages/stream",
      sessionId: metadata.id,
      message: "Inspect this",
      requestImages: [],
    });
    await response.text();

    expect(store.getMetadata(metadata.id)?.lastRun).toBeNull();
    expect(store.messages(metadata.id)).toEqual([]);
  });

  it("settles an actual Runtime start failure as an error", async () => {
    const { store, metadata } = createStore();
    const turn = createExternalCliTurn({
      runtime: {} as AppRuntime,
      sessionId: metadata.id,
      message: "Inspect this",
      requestImages: [],
      sessionStore: store,
      model: metadata.snapshot.model,
      usage: "reported",
      persistFailedTurn: false,
      errorCode: () => null,
    });

    await expect(turn.prepare(async () => {
      throw new Error("spawn failed");
    })).rejects.toThrow("spawn failed");

    expect(store.getMetadata(metadata.id)?.lastRun).toMatchObject({
      status: "error",
      error: "spawn failed",
    });
    expect(store.messages(metadata.id)).toEqual([]);
  });

  it("retries terminal persistence after a transient endRun failure", async () => {
    const { store, metadata } = createStore();
    const persistenceError = new Error("metadata temporarily unavailable");
    let endRunAttempts = 0;
    const sessionStore = sessionStorePort(store, {
      endRun(id, input) {
        endRunAttempts += 1;
        if (endRunAttempts === 1) throw persistenceError;
        store.endRun(id, input);
      },
    });
    const turn = createExternalCliTurn({
      runtime: {} as AppRuntime,
      sessionId: metadata.id,
      message: "Inspect this",
      requestImages: [],
      sessionStore,
      model: metadata.snapshot.model,
      usage: "reported",
      errorCode: () => null,
    });
    const run = externalRun();
    await turn.prepare(async () => run);

    await expect(turn.complete({ output: "done", error: null }, () => undefined))
      .rejects.toThrow("metadata temporarily unavailable");
    await turn.fail(persistenceError, () => undefined);

    expect(endRunAttempts).toBe(2);
    expect(store.getMetadata(metadata.id)?.lastRun).toMatchObject({
      status: "error",
      error: "metadata temporarily unavailable",
    });
    expect(store.messages(metadata.id).at(-1)).toMatchObject({
      role: "assistant",
      content: "done",
    });
  });

  it("overrides a completed run when later terminal persistence fails", async () => {
    const { store, metadata } = createStore();
    const persistenceError = new Error("native Session id could not be saved");
    const sessionStore = sessionStorePort(store, {
      setNativeSessionId() {
        throw persistenceError;
      },
    });
    const turn = createExternalCliTurn({
      runtime: {} as AppRuntime,
      sessionId: metadata.id,
      message: "Inspect this",
      requestImages: [],
      sessionStore,
      model: metadata.snapshot.model,
      usage: "reported",
      errorCode: () => null,
    });
    await turn.prepare(async () => externalRun());

    await expect(turn.complete({
      output: "done",
      nativeSessionId: "native-result-id",
      error: null,
    }, () => undefined)).rejects.toThrow("native Session id could not be saved");
    await turn.fail(persistenceError, () => undefined);

    expect(store.getMetadata(metadata.id)?.lastRun).toMatchObject({
      status: "error",
      error: "native Session id could not be saved",
    });
    expect(store.messages(metadata.id).at(-1)).toMatchObject({
      role: "assistant",
      content: "done",
    });
  });

  it("projects one normalized code for an unclassified Runtime failure", async () => {
    const { store, metadata } = createStore();
    const turn = createExternalCliTurn({
      runtime: {} as AppRuntime,
      sessionId: metadata.id,
      message: "Inspect this",
      requestImages: [],
      sessionStore: store,
      model: metadata.snapshot.model,
      usage: "reported",
      errorCode: () => null,
    });
    await turn.prepare(async () => externalRun());
    const sent: Array<Record<string, unknown>> = [];

    await turn.fail(new Error("listener write failed"), (event) => sent.push(event));

    expect(store.messages(metadata.id).at(-1)?.metadata).toMatchObject({
      errorCode: "runtime_failure",
    });
    expect(sent).toEqual([
      expect.objectContaining({ type: "error", code: "runtime_failure" }),
      expect.objectContaining({ type: "agent_end", errorCode: "runtime_failure" }),
    ]);
  });

  it("preserves a typed Runtime listener failure across every projection", async () => {
    const { store, metadata } = createStore();
    const runtime = {
      lockedAgentSessions: new Set<string>(),
      activeAgents: new Map(),
    } as unknown as AppRuntime;
    const turn = createExternalCliTurn({
      runtime,
      sessionId: metadata.id,
      message: "Inspect this",
      requestImages: [],
      sessionStore: store,
      model: metadata.snapshot.model,
      usage: "reported",
      errorCode: (error) => error instanceof SessionRunError ? error.code : null,
    });
    const response = streamSessionRun({
      runtime,
      sessionId: metadata.id,
      async prepare() {
        const run = await turn.prepare(async () => ({
          ...externalRun(),
          result: Promise.resolve({
            output: "",
            error: "listener write failed",
            errorCode: "runtime_listener_failed",
          }),
        }));
        return {
          run,
          onEvent: turn.onEvent,
          complete: turn.complete,
          fail: turn.fail,
        };
      },
    });

    const events = sseEvents(await response.text());

    expect(store.messages(metadata.id).at(-1)?.metadata).toMatchObject({
      errorCode: "runtime_listener_failed",
    });
    expect(events).toEqual([
      expect.objectContaining({ type: "agent_start" }),
      expect.objectContaining({ type: "error", code: "runtime_listener_failed" }),
      expect.objectContaining({ type: "agent_end", errorCode: "runtime_listener_failed" }),
    ]);
  });

  it("emits one terminal agent_end when the final Session projection fails", async () => {
    const { store, metadata } = createStore();
    const runtime = {
      lockedAgentSessions: new Set<string>(),
      activeAgents: new Map(),
    } as unknown as AppRuntime;
    const projectSessionUpdate = vi.fn(async () => {
      throw new Error("Session projection failed");
    });
    const turn = createExternalCliTurn({
      runtime,
      sessionId: metadata.id,
      message: "Inspect this",
      requestImages: [],
      sessionStore: store,
      model: metadata.snapshot.model,
      usage: "reported",
      projectSessionUpdate,
      persistFailedTurn: true,
      errorCode: () => null,
    });
    const response = streamSessionRun({
      runtime,
      sessionId: metadata.id,
      async prepare() {
        const run = await turn.prepare(async () => externalRun());
        return {
          run,
          onEvent: turn.onEvent,
          complete: turn.complete,
          fail: turn.fail,
        };
      },
    });

    const events = sseEvents(await response.text());

    expect(projectSessionUpdate).toHaveBeenCalledOnce();
    expect(events.filter((event) => event.type === "agent_end")).toHaveLength(1);
    expect(events.at(-2)).toMatchObject({
      type: "error",
      code: "runtime_failure",
      error: "Session projection failed",
    });
    expect(events.at(-1)).toMatchObject({
      type: "agent_end",
      error: "Session projection failed",
      errorCode: "runtime_failure",
    });
  });
});

function createStore() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tradex-external-turn-"));
  roots.push(root);
  const store = new ExternalSessionStore<"claude-code", ExternalSessionSnapshot<"claude-code">>({
    root,
    runtime: "claude-code",
    runtimeLabel: "Test Claude",
    capabilities: CLAUDE_CODE_CAPABILITIES,
  });
  const metadata = store.create({
    title: "Test Session",
    snapshot: {
      runtime: "claude-code",
      systemPrompt: "",
      provider: null,
      model: "sonnet",
      reasoningEffort: "high",
    },
  });
  return { root, store, metadata };
}

function sessionStorePort(
  store: ExternalSessionStore<"claude-code", ExternalSessionSnapshot<"claude-code">>,
  overrides: Partial<ExternalSessionStorePort<"claude-code">> = {},
): ExternalSessionStorePort<"claude-code"> {
  return {
    getMetadata: store.getMetadata.bind(store),
    sessionDir: store.sessionDir.bind(store),
    writeAttachment: store.writeAttachment.bind(store),
    beginRun: store.beginRun.bind(store),
    endRun: store.endRun.bind(store),
    appendMessage: store.appendMessage.bind(store),
    setNativeSessionId: store.setNativeSessionId.bind(store),
    ...overrides,
  };
}

function externalRun(): ActiveRuntimeRun {
  return {
    runtime: "claude-code",
    capabilities: CLAUDE_CODE_CAPABILITIES,
    result: Promise.resolve({ output: "done", error: null }),
    subscribe: () => () => undefined,
    abort: () => undefined,
  };
}

function sseEvents(body: string): Array<Record<string, unknown>> {
  return body.split("\n\n").filter(Boolean).map((frame) => {
    const envelope = JSON.parse(frame.replace(/^data: /, "")) as { event: Record<string, unknown> };
    return envelope.event;
  });
}
