import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OriginSessionStore } from "../../origin/session-store.js";
import type { AppRuntime } from "../runtime.js";
import { originRoutes } from "./origin.js";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));

function runtime(): AppRuntime & { ensureDm: ReturnType<typeof vi.fn>; ensureContext: ReturnType<typeof vi.fn> } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tradex-origin-api-"));
  dirs.push(root);
  const ensureDm = vi.fn();
  const ensureContext = vi.fn();
  return {
    originSessions: new OriginSessionStore(root),
    lockedAgentSessions: new Set(),
    activeAgents: new Map(),
    modelRuntimeSnapshot: {
      resolveSelection: () => ({ runnable: true }),
    },
    config: {
      agent: {
        provider: "codex",
        model: "gpt-5.4",
        reasoningEffort: "high",
        systemPrompt: "",
        maxCandles: 100,
        candleContextMode: "raw",
        providerProfiles: {
          codex: { modelEfforts: [["gpt-5.4", "high"]] },
        },
      },
    },
    agentContextManager: { ensure: ensureContext },
    messageStore: { ensureHumanAgentDm: ensureDm },
    ensureDm,
    ensureContext,
  } as unknown as AppRuntime & { ensureDm: ReturnType<typeof vi.fn>; ensureContext: ReturnType<typeof vi.fn> };
}

describe("Origin HTTP API", () => {
  it("creates and lists an Origin without creating Agent Context or DM", async () => {
    const appRuntime = runtime();
    const routes = originRoutes(appRuntime);
    const created = await routes.request("/api/origins", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Fresh analysis", runtime: "pi", provider: "codex", model: "gpt-5.4" }),
    });
    const payload = await created.json() as { session: Record<string, unknown> };
    const listed = await routes.request("/api/origins");
    const history = await listed.json() as { sessions: Array<Record<string, unknown>> };

    expect(created.status).toBe(201);
    expect(payload.session).toMatchObject({ title: "Fresh analysis", owner: { kind: "origin" } });
    expect(payload.session).not.toHaveProperty("agentId");
    expect(history.sessions).toHaveLength(1);
    expect(appRuntime.ensureContext).not.toHaveBeenCalled();
    expect(appRuntime.ensureDm).not.toHaveBeenCalled();
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
