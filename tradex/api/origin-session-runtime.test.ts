import { afterEach, describe, expect, it, vi } from "vitest";
import { purgeClaudeProject } from "../agent/runtime/claude-code/runtime.js";
import { streamPiSession } from "./pi-session-stream.js";
import { deleteOriginSession, resolveOriginSkillInstructions, streamOriginSession } from "./origin-session-runtime.js";

vi.mock("../agent/runtime/claude-code/runtime.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../agent/runtime/claude-code/runtime.js")>();
  return { ...actual, purgeClaudeProject: vi.fn() };
});

vi.mock("./pi-session-stream.js", () => ({
  streamPiSession: vi.fn(() => new Response("stream")),
}));

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

describe("Origin skill instructions", () => {
  it("resolves the explicitly selected skills for one Origin turn", () => {
    const resolve = vi.fn(() => ({ instructions: "<skill>Think carefully</skill>", warnings: [] }));

    expect(resolveOriginSkillInstructions({ resolve }, ["think", "codebase-design"]))
      .toBe("<skill>Think carefully</skill>");
    expect(resolve).toHaveBeenCalledWith(["think", "codebase-design"]);
  });

  it("returns valid instructions while reporting unavailable selections", () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const instructions = resolveOriginSkillInstructions({
      resolve: () => ({ instructions: "", warnings: ["Skill not found or unavailable: missing"] }),
    }, ["missing"]);

    expect(instructions).toBe("");
    expect(warning).toHaveBeenCalledWith("[skills] Skill not found or unavailable: missing");
    warning.mockRestore();
  });
});

describe("Origin lifecycle", () => {
  it("runs Pi inside the Origin-owned workspace", async () => {
    const manager = { buildSessionContext: () => ({ thinkingLevel: "high" }) };
    const runtime = {
      config: {
        agent: {
          provider: "codex",
          model: "gpt-5.4",
          reasoningEffort: "high",
          providerProfiles: {},
        },
      },
      originSessions: {
        getMetadata: () => ({
          workspace: "/tmp/origin-owned-workspace",
          snapshot: {
            owner: { kind: "origin" },
            runtime: "pi",
            provider: "codex",
            model: "gpt-5.4",
            reasoningEffort: "high",
            systemPrompt: "Configured prompt",
          },
        }),
        openPi: vi.fn(async () => manager),
        response: vi.fn(async () => ({ session: null, messages: [], run: {} })),
        history: vi.fn(async () => ({ sessions: [] })),
        release: vi.fn(),
      },
      skillCatalog: { resolve: () => ({ instructions: "", warnings: [] }) },
      lockedAgentSessions: new Set<string>(),
    };

    await streamOriginSession({
      runtime: runtime as never,
      requestUrl: "http://127.0.0.1:8765/api/origins/id/messages/stream",
      sessionId: "origin-id",
      message: "hello",
      images: [],
      skillNames: [],
    });

    expect(streamPiSession).toHaveBeenCalledWith(expect.objectContaining({
      workspace: "/tmp/origin-owned-workspace",
      additionalSystemPrompt: expect.stringContaining("Origin Session"),
    }));
    expect(vi.mocked(streamPiSession).mock.calls[0]?.[0].additionalSystemPrompt).not.toContain("Agent Session");
  });

  it("purges Claude native state before removing its owned projection", async () => {
    vi.stubEnv("TRADEX_CLAUDE_PATH", "/opt/claude-test");
    const remove = vi.fn(async () => true);
    const runtime = {
      originSessions: {
        deletionTarget: () => ({
          workspace: "/tmp/origin-workspace",
          ownsWorkspace: true,
          runtime: "claude-code",
        }),
        remove,
      },
      lockedAgentSessions: new Set<string>(),
    };

    await expect(deleteOriginSession(runtime as never, "session-id")).resolves.toBe("ok");
    expect(purgeClaudeProject).toHaveBeenCalledWith("/opt/claude-test", "/tmp/origin-workspace");
    expect(remove).toHaveBeenCalledWith("session-id");
    expect(vi.mocked(purgeClaudeProject).mock.invocationCallOrder[0])
      .toBeLessThan(remove.mock.invocationCallOrder[0]!);
  });

  it("does not purge Claude native state for a legacy shared workspace", async () => {
    const remove = vi.fn(async () => true);
    const runtime = {
      originSessions: {
        deletionTarget: () => ({
          workspace: "/tmp/legacy-shared-workspace",
          ownsWorkspace: false,
          runtime: "claude-code",
        }),
        remove,
      },
      lockedAgentSessions: new Set<string>(),
    };

    await expect(deleteOriginSession(runtime as never, "session-id")).resolves.toBe("ok");
    expect(purgeClaudeProject).not.toHaveBeenCalled();
    expect(remove).toHaveBeenCalledWith("session-id");
  });
});
