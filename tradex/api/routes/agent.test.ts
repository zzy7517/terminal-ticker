import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentStore } from "../../agent/agent_store.js";
import { agentRoutes } from "./agent.js";
import type { AppRuntime } from "../runtime.js";
import { piSessionFileExists } from "../../agent/pi_sessions.js";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));

function runtime(): AppRuntime {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tradex-agent-api-"));
  dirs.push(dir);
  const agentStore = new AgentStore(dir);
  agentStore.create({
    id: "ict",
    name: "ICT 理论分析",
    description: "ICT",
    systemPrompt: "ICT prompt",
    runtime: "pi",
    provider: null,
    model: null,
    reasoningEffort: null,
  });
  return {
    agentStore,
    config: { agent: { provider: "codex", model: "gpt-5.4", reasoningEffort: "high", systemPrompt: "" } },
    pendingSessionManagers: new Map(),
    pendingAgentSnapshots: new Map(),
    lockedAgentSessions: new Set(),
  } as unknown as AppRuntime;
}

describe("Agent HTTP API", () => {
  it("creates an in-memory Session projected under the selected Agent", async () => {
    const appRuntime = runtime();
    const response = await agentRoutes(appRuntime).request("/api/agent/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agentId: "ict" }),
    });
    const payload = await response.json() as { session: { agentId: string; agentName: string } };

    expect(response.status).toBe(200);
    expect(payload.session).toMatchObject({ agentId: "ict", agentName: "ICT 理论分析" });
    const pending = appRuntime.pendingSessionManagers.values().next().value;
    expect(pending && piSessionFileExists(pending)).toBe(false);
  });

  it("rejects an update body that tries to change the Agent id", async () => {
    const response = await agentRoutes(runtime()).request("/api/agents/ict", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "other", name: "Other" }),
    });

    expect(response.status).toBe(400);
  });
});
