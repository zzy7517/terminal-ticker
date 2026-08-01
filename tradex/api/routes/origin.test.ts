import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OriginSessionStore } from "../../origin/session-store.js";
import type { AppRuntime } from "../runtime.js";
import { originRoutes } from "./origin.js";

const dirs: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  dirs.splice(0).forEach((dir) => fs.rmSync(dir, { recursive: true, force: true }));
});

function runtime(): AppRuntime & { ensureDm: ReturnType<typeof vi.fn>; ensureContext: ReturnType<typeof vi.fn>; originRoot: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tradex-origin-api-"));
  dirs.push(root);
  const ensureDm = vi.fn();
  const ensureContext = vi.fn();
  return {
    originSessions: new OriginSessionStore(root),
    lockedAgentSessions: new Set(),
    activeAgents: new Map(),
    pendingSessionManagers: new Map(),
    modelRuntimeSnapshot: {
      resolveSelection: () => ({ runnable: true, input: ["text", "image"] }),
    },
    config: {
      agent: {
        provider: "codex",
        model: "gpt-5.4",
        reasoningEffort: "high",
        systemPrompt: "Configured Origin instructions",
        maxCandles: 100,
        candleContextMode: "raw",
        providerProfiles: {
          codex: { modelEfforts: [["gpt-5.4", "high"]] },
        },
      },
    },
    agentContexts: { ensure: ensureContext },
    messageStore: { ensureHumanAgentDm: ensureDm },
    skillCatalog: { resolve: () => ({ instructions: "", warnings: [] }) },
    listenOrigin: "http://127.0.0.1:8765",
    ensureDm,
    ensureContext,
    originRoot: root,
  } as unknown as AppRuntime & { ensureDm: ReturnType<typeof vi.fn>; ensureContext: ReturnType<typeof vi.fn>; originRoot: string };
}

describe("Origin HTTP API", () => {
  it("does not expose a create-only Origin endpoint", async () => {
    const appRuntime = runtime();
    const response = await originRoutes(appRuntime).request("/api/origins", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Fresh analysis", runtime: "pi", provider: "codex", model: "gpt-5.4" }),
    });

    expect(response.status).toBe(404);
    expect((await appRuntime.originSessions.history(new Set())).sessions).toHaveLength(0);
  });

  it("materializes on the first send and exposes the Session ID before the SSE body", async () => {
    const appRuntime = runtime();
    vi.stubEnv("TRADEX_CLAUDE_PATH", path.join(appRuntime.originRoot, "missing-claude"));
    const response = await originRoutes(appRuntime).request("/api/origins/messages/stream", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        materializationId: "draft-first-send",
        config: {
          runtime: "claude-code",
          model: "sonnet",
          workspace: "/tmp/client-selected-workspace",
          systemPrompt: "Client-selected prompt",
        },
        message: "Inspect this market",
      }),
    });
    const sessionId = response.headers.get("X-Origin-Session-Id");

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(sessionId).toMatch(/^[0-9a-f-]{36}$/i);
    const metadata = appRuntime.originSessions.getMetadata(sessionId!);
    expect(metadata).toMatchObject({
      materializationId: "draft-first-send",
      workspaceOwned: true,
      snapshot: {
        runtime: "claude-code",
        systemPrompt: "Configured Origin instructions",
      },
    });
    expect(metadata?.workspace.startsWith(path.join(appRuntime.originRoot, "workspaces") + path.sep)).toBe(true);
    expect(appRuntime.ensureContext).not.toHaveBeenCalled();
    expect(appRuntime.ensureDm).not.toHaveBeenCalled();
    await response.text();
  });

  it("returns the existing Session for a duplicate materialization key", async () => {
    const appRuntime = runtime();
    vi.stubEnv("TRADEX_CLAUDE_PATH", path.join(appRuntime.originRoot, "missing-claude"));
    const request = () => originRoutes(appRuntime).request("/api/origins/messages/stream", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        materializationId: "draft-retry",
        config: { runtime: "claude-code", model: "sonnet" },
        message: "Start once",
      }),
    });
    const first = await request();
    const sessionId = first.headers.get("X-Origin-Session-Id");
    await first.text();
    const duplicate = await request();

    expect(duplicate.status).toBe(409);
    expect(await duplicate.json()).toEqual({
      detail: "Origin was already materialized",
      sessionId,
    });
    expect((await appRuntime.originSessions.history(new Set())).sessions).toHaveLength(1);
  });

  it("projects run status without hydrating the Session transcript", async () => {
    const appRuntime = runtime();
    const { id } = appRuntime.originSessions.create({
      runtime: "claude-code", model: "sonnet", reasoningEffort: "high",
    });
    appRuntime.lockedAgentSessions.add(id);
    const fullResponse = vi.spyOn(appRuntime.originSessions, "response");

    const response = await originRoutes(appRuntime).request(`/api/origins/${id}/run`);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ run: { sessionId: id, status: "running" } });
    expect(fullResponse).not.toHaveBeenCalled();
  });

  it.each([
    [{ config: { runtime: "pi" }, message: "Missing key" }, "materializationId is required"],
    [{ materializationId: "draft-empty", config: { runtime: "pi" } }, "message or images is required"],
    [{ materializationId: "draft-runtime", config: { runtime: "unknown" }, message: "Hello" }, "unsupported Origin runtime"],
    [{ materializationId: "draft-image", config: { runtime: "pi" }, message: "Hello", images: [{ data: 42, mimeType: "image/png" }] }, "images must contain base64 data and mimeType"],
    [{ materializationId: "draft-base64", config: { runtime: "pi" }, message: "Hello", images: [{ data: "A", mimeType: "image/png" }] }, "image data must be valid base64"],
    [{ materializationId: "draft-images", config: { runtime: "pi" }, message: "Hello", images: Array.from({ length: 11 }, () => ({ data: "YQ==", mimeType: "image/png" })) }, "at most 10 images are allowed"],
    [{ materializationId: "draft-message", config: { runtime: "pi" }, message: 42 }, "message must be a string"],
    [{ materializationId: "draft-skills", config: { runtime: "pi" }, message: "Hello", skillNames: [42] }, "skillNames must be an array of strings"],
  ])("rejects an invalid first send without creating an Origin", async (body, detail) => {
    const appRuntime = runtime();
    const response = await originRoutes(appRuntime).request("/api/origins/messages/stream", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ detail });
    expect((await appRuntime.originSessions.history(new Set())).sessions).toHaveLength(0);
  });

  it("validates the Pi model before creating any Origin files", async () => {
    const appRuntime = runtime();
    appRuntime.modelRuntimeSnapshot.resolveSelection = () => ({ runnable: false }) as never;
    const response = await originRoutes(appRuntime).request("/api/origins/messages/stream", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        materializationId: "draft-unrunnable",
        config: { runtime: "pi", provider: "codex", model: "missing-model" },
        message: "Hello",
      }),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ detail: "selected model is not runnable" });
    expect(fs.existsSync(path.join(appRuntime.originRoot, "workspaces"))).toBe(false);
  });

  it("rejects first-send images when the selected Pi model is text-only", async () => {
    const appRuntime = runtime();
    appRuntime.modelRuntimeSnapshot.resolveSelection = () => ({ runnable: true, input: ["text"] }) as never;

    const response = await originRoutes(appRuntime).request("/api/origins/messages/stream", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        materializationId: "draft-text-only",
        config: { runtime: "pi", provider: "codex", model: "gpt-5.4" },
        images: [{ data: "aGVsbG8=", mimeType: "image/png" }],
      }),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ detail: "selected model does not support image input" });
    expect((await appRuntime.originSessions.history(new Set())).sessions).toHaveLength(0);
  });

  it.each([
    { message: "Inspect this image", images: [{ data: 42, mimeType: "image/png" }] },
    { message: "Use a skill", skillNames: [42] },
  ])("filters malformed optional continuation fields", async (body) => {
    const appRuntime = runtime();
    const { id } = appRuntime.originSessions.create({
      runtime: "pi",
      provider: "codex",
      model: "gpt-5.4",
      reasoningEffort: "high",
    });

    const response = await originRoutes(appRuntime).request(`/api/origins/${id}/messages/stream`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

    expect(response.status).toBe(200);
    await response.text();
    expect(appRuntime.lockedAgentSessions.has(id)).toBe(false);
  });

  it("treats a malformed continuation message as empty input", async () => {
    const appRuntime = runtime();
    const { id } = appRuntime.originSessions.create({
      runtime: "pi", provider: "codex", model: "gpt-5.4", reasoningEffort: "high",
    });

    const response = await originRoutes(appRuntime).request(`/api/origins/${id}/messages/stream`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: 42 }),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ detail: "message or images is required" });
  });

  it("rejects continuation images when the persisted Pi model is text-only", async () => {
    const appRuntime = runtime();
    const { id } = appRuntime.originSessions.create({
      runtime: "pi",
      provider: "codex",
      model: "gpt-5.4",
      reasoningEffort: "high",
    });
    appRuntime.modelRuntimeSnapshot.resolveSelection = () => ({ runnable: true, input: ["text"] }) as never;

    const response = await originRoutes(appRuntime).request(`/api/origins/${id}/messages/stream`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ images: [{ data: "aGVsbG8=", mimeType: "image/png" }] }),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ detail: "selected model does not support image input" });
    expect(appRuntime.lockedAgentSessions.has(id)).toBe(false);
  });

  it("returns a structured error when a persisted Pi model is no longer available", async () => {
    const appRuntime = runtime();
    const { id } = appRuntime.originSessions.create({
      runtime: "pi",
      provider: "codex",
      model: "removed-model",
      reasoningEffort: "high",
    });
    appRuntime.modelRuntimeSnapshot.resolveSelection = () => {
      throw new Error("Unknown model selection: openai-codex/removed-model");
    };

    const response = await originRoutes(appRuntime).request(`/api/origins/${id}/messages/stream`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ images: [{ data: "aGVsbG8=", mimeType: "image/png" }] }),
    });

    expect(response.status).toBe(400);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(await response.json()).toEqual({
      detail: "Unknown model selection: openai-codex/removed-model",
    });
    expect(appRuntime.lockedAgentSessions.has(id)).toBe(false);
  });

  it("rolls back a materialized Origin when no SSE stream can be established", async () => {
    const appRuntime = runtime();
    vi.spyOn(appRuntime.originSessions, "openPi").mockResolvedValue(null);

    const response = await originRoutes(appRuntime).request("/api/origins/messages/stream", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        materializationId: "draft-missing-transcript",
        config: { runtime: "pi", provider: "codex", model: "gpt-5.4" },
        message: "Hello",
      }),
    });

    expect(response.status).toBe(404);
    expect(response.headers.get("X-Origin-Session-Id")).toBeNull();
    expect(await response.json()).toEqual({ detail: "Origin transcript not found" });
    expect((await appRuntime.originSessions.history(new Set())).sessions).toHaveLength(0);
    expect(fs.readdirSync(path.join(appRuntime.originRoot, "workspaces"))).toEqual([]);
  });

  it("releases the Pi manager when Runtime preparation fails", async () => {
    const appRuntime = runtime();
    const release = vi.spyOn(appRuntime.originSessions, "release");

    const response = await originRoutes(appRuntime).request("/api/origins/messages/stream", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        materializationId: "draft-prepare-failure",
        config: { runtime: "pi", provider: "codex", model: "gpt-5.4" },
        message: "Start even if the fake Runtime cannot prepare",
      }),
    });
    const sessionId = response.headers.get("X-Origin-Session-Id");

    expect(response.status).toBe(200);
    await response.text();
    expect(release).toHaveBeenCalledOnce();
    expect(appRuntime.lockedAgentSessions.has(sessionId!)).toBe(false);
  });

  it("attempts a failed Pi projection once and emits one terminal event", async () => {
    const appRuntime = runtime();
    const { id } = appRuntime.originSessions.create({
      runtime: "pi", provider: "codex", model: "gpt-5.4", reasoningEffort: "high",
    });
    const project = vi.spyOn(appRuntime.originSessions, "response").mockRejectedValue(new Error("projection failed"));

    const response = await originRoutes(appRuntime).request(`/api/origins/${id}/messages/stream`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "project once" }),
    });
    const events = sseEvents(await response.text());

    expect(project).toHaveBeenCalledOnce();
    expect(events.filter((event) => event.type === "agent_end")).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({ type: "agent_end", error: "projection failed" });
  });

  it("transfers a stopped Pi preflight into an aborted SSE terminal", async () => {
    const appRuntime = runtime();
    const { id } = appRuntime.originSessions.create({
      runtime: "pi", provider: "codex", model: "gpt-5.4", reasoningEffort: "high",
    });
    const manager = await appRuntime.originSessions.openPi(id);
    let releaseOpen!: (value: typeof manager) => void;
    const delayedOpen = new Promise<typeof manager>((resolve) => { releaseOpen = resolve; });
    const openPi = vi.spyOn(appRuntime.originSessions, "openPi").mockReturnValueOnce(delayedOpen);
    const routes = originRoutes(appRuntime);

    const streaming = routes.request(`/api/origins/${id}/messages/stream`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "stop during preflight" }),
    });
    await vi.waitFor(() => expect(openPi).toHaveBeenCalledOnce());
    const stopped = await routes.request(`/api/origins/${id}/stop`, { method: "POST" });
    releaseOpen(manager);
    const response = await streaming;
    const events = sseEvents(await response.text());

    expect(stopped.status).toBe(202);
    expect(response.status).toBe(200);
    expect(events.at(-1)).toMatchObject({ type: "agent_end", errorCode: "aborted", error: null });
    expect(appRuntime.lockedAgentSessions.has(id)).toBe(false);
  });

  it("rejects deleting a running Origin", async () => {
    const appRuntime = runtime();
    const { id } = appRuntime.originSessions.create({
      runtime: "pi",
      provider: "codex",
      model: "gpt-5.4",
      reasoningEffort: "high",
    });
    appRuntime.lockedAgentSessions.add(id);

    const response = await originRoutes(appRuntime).request(`/api/origins/${id}`, {
      method: "DELETE",
    });

    expect(response.status).toBe(409);
    expect(await appRuntime.originSessions.openPi(id)).not.toBeNull();
  });

  it("cannot stop a fixed Agent session through the Origin route", async () => {
    const appRuntime = runtime();
    const abort = vi.fn();
    const fixedAgentSessionId = "11111111-1111-4111-8111-111111111111";
    appRuntime.activeAgents.set(fixedAgentSessionId, { abort } as never);

    const response = await originRoutes(appRuntime).request(`/api/origins/${fixedAgentSessionId}/stop`, { method: "POST" });

    expect(response.status).toBe(404);
    expect(abort).not.toHaveBeenCalled();
  });

});

function sseEvents(body: string): Array<Record<string, unknown>> {
  return body.split("\n\n").filter(Boolean).map((frame) => {
    const envelope = JSON.parse(frame.replace(/^data: /, "")) as { event: Record<string, unknown> };
    return envelope.event;
  });
}
