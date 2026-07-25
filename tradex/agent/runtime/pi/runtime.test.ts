import { beforeEach, describe, expect, it, vi } from "vitest";

const sdk = vi.hoisted(() => {
  const resourceLoaderInputs: Array<Record<string, unknown>> = [];
  const createAgentSession = vi.fn();
  const createBashTool = vi.fn(() => ({ name: "bash" }));
  const prepareTradexCli = vi.fn(async () => ({ env: {}, cleanup: vi.fn() }));
  return { resourceLoaderInputs, createAgentSession, createBashTool, prepareTradexCli };
});

vi.mock("@earendil-works/pi-coding-agent", () => ({
  createAgentSession: sdk.createAgentSession,
  createBashTool: sdk.createBashTool,
  DefaultResourceLoader: class {
    constructor(input: Record<string, unknown>) { sdk.resourceLoaderInputs.push(input); }
    async reload() {}
  },
  getAgentDir: () => "/tmp/pi-agent",
  SessionManager: class {
    static inMemory() { return {}; }
  },
  SettingsManager: { inMemory: () => ({}) },
}));

vi.mock("../cli-tools.js", () => ({
  CliRunGrantStore: class {},
  prepareTradexCli: sdk.prepareTradexCli,
}));

import { PiActiveRuntimeRun, PiSdkRuntime, type PiAgentRuntime } from "./runtime.js";

function fakeAgent(prompt: PiAgentRuntime["prompt"], abort: PiAgentRuntime["abort"] = vi.fn()) {
  return {
    messages: [],
    subscribe: vi.fn(() => () => {}),
    prompt: vi.fn(prompt),
    abort: vi.fn(abort),
    dispose: vi.fn(),
  } satisfies PiAgentRuntime;
}

beforeEach(() => {
  vi.clearAllMocks();
  sdk.resourceLoaderInputs.length = 0;
});

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

describe("PiSdkRuntime workspace", () => {
  it("uses the run cwd for the CLI, resources, Bash, and native session", async () => {
    const session = {
      agent: {
        state: { messages: [] },
        toolExecution: "parallel",
        streamFn: vi.fn(),
        abort: vi.fn(),
      },
      subscribe: vi.fn(() => () => {}),
      prompt: vi.fn(async () => {}),
      abort: vi.fn(),
      dispose: vi.fn(),
    };
    sdk.createAgentSession.mockResolvedValue({ session });
    const grants = {
      issue: vi.fn(() => ({ token: "grant" })),
      revoke: vi.fn(),
    };

    const run = await new PiSdkRuntime().start({
      cwd: "/tmp/origin-owned-workspace",
      config: { reasoningEffort: "high" } as never,
      modelRuntime: {
        resolve: () => ({ model: {}, modelRuntime: {} }),
      } as never,
      systemPrompt: "Origin",
      tools: {} as never,
      tradexSessionId: "origin-session",
      cliUrl: "http://127.0.0.1:8765/cli/tradex/invoke",
      grants: grants as never,
      sessionManager: {} as never,
      prompt: "hello",
    });
    await run.result;

    expect(sdk.prepareTradexCli).toHaveBeenCalledWith(expect.objectContaining({
      cwd: "/tmp/origin-owned-workspace",
    }));
    expect(sdk.resourceLoaderInputs).toContainEqual(expect.objectContaining({
      cwd: "/tmp/origin-owned-workspace",
    }));
    expect(sdk.createBashTool).toHaveBeenCalledWith(
      "/tmp/origin-owned-workspace",
      expect.any(Object),
    );
    expect(sdk.createAgentSession).toHaveBeenCalledWith(expect.objectContaining({
      cwd: "/tmp/origin-owned-workspace",
    }));
  });
});
