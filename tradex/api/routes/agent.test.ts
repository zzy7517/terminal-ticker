import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentStore } from "../../agent/agent_store.js";
import { agentRoutes } from "./agent.js";
import type { AppRuntime } from "../runtime.js";
import { piSessionFileExists } from "../../agent/runtime/pi/sessions.js";
import { ClaudeSessionStore } from "../../agent/runtime/claude-code/session-store.js";
import { McpRunGrantStore } from "../../mcp/server/grants.js";
import { promptWithAttachments } from "../claude-session-stream.js";

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
    config: {
      agent: {
        provider: "codex", model: "gpt-5.4", reasoningEffort: "high", systemPrompt: "",
        maxCandles: 100, candleContextMode: "raw", providerProfiles: {},
      },
      browser: { enabled: false },
      trading: {},
    },
    controller: { quotes: new Map() },
    newsService: { recent: () => [], refreshNow: async () => [] },
    tradeStore: {},
    exchangeRouter: {},
    jin10Service: {},
    browserManager: {},
    optionsService: null,
    pendingSessionManagers: new Map(),
    pendingAgentSnapshots: new Map(),
    lockedAgentSessions: new Set(),
    activeAgents: new Map(),
    claudeSessions: new ClaudeSessionStore(path.join(dir, "claude-sessions")),
    mcpRunGrants: new McpRunGrantStore(),
    state: async () => ({}),
  } as unknown as AppRuntime;
}

describe("Agent HTTP API", () => {
  it("projects Claude attachments as relative paths for native Read", () => {
    const prompt = promptWithAttachments("Inspect this", ["/private/session/attachments/image-id.png"]);
    expect(prompt).toContain("attachments/image-id.png");
    expect(prompt).not.toContain("/private/session");
    expect(prompt).not.toContain("read_session_attachment");
  });

  it("returns Pi as the built-in runtime without probing it", async () => {
    const response = await agentRoutes(runtime()).request("/api/agent/runtimes");
    const payload = await response.json() as { runtimes: Array<Record<string, unknown>> };
    expect(payload.runtimes[0]).toMatchObject({ id: "pi", available: true, version: null, error: null });
  });

  it("returns the structured Claude model catalog", async () => {
    const response = await agentRoutes(runtime()).request("/api/agent/runtimes/claude-code/models");
    const payload = await response.json() as { models: Array<Record<string, unknown>>; supportsCustomModel: boolean };
    expect(payload.supportsCustomModel).toBe(true);
    expect(payload.models).toContainEqual(expect.objectContaining({ id: "sonnet", default: true, thinking: expect.any(Object) }));
  });

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

  it("does not delete an Agent while an empty Pi Session still belongs to it", async () => {
    const appRuntime = runtime();
    await agentRoutes(appRuntime).request("/api/agent/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agentId: "ict" }),
    });

    const response = await agentRoutes(appRuntime).request("/api/agents/ict", { method: "DELETE" });

    expect(response.status).toBe(409);
    expect(appRuntime.agentStore.get("ict")).not.toBeNull();
  });

  it("creates a Claude Code Session without adding it to the Pi provider registry", async () => {
    const appRuntime = runtime();
    appRuntime.agentStore.create({
      id: "claude-reader",
      name: "Claude Reader",
      description: "Local Claude Code",
      systemPrompt: "Read-only analysis",
      runtime: "claude-code",
      provider: null,
      model: "opus",
      reasoningEffort: "high",
    });

    const response = await agentRoutes(appRuntime).request("/api/agent/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agentId: "claude-reader" }),
    });
    const payload = await response.json() as { session: Record<string, unknown> };

    expect(response.status).toBe(200);
    expect(payload.session).toMatchObject({
      runtime: "claude-code",
      provider: null,
      model: "opus",
      agentId: "claude-reader",
    });
    expect(appRuntime.pendingSessionManagers.size).toBe(0);
  });

  it("does not expose removed fork, clone, or steer routes", async () => {
    const appRuntime = runtime();
    const metadata = appRuntime.claudeSessions.create({
      title: "Claude",
      snapshot: {
        agentId: "claude-reader",
        agentName: "Claude Reader",
        runtime: "claude-code",
        systemPrompt: "Read only",
        provider: null,
        model: null,
        reasoningEffort: null,
      },
    });

    for (const endpoint of ["fork", "clone", "steer"]) {
      const response = await agentRoutes(appRuntime).request(`/api/agent/sessions/${metadata.id}/${endpoint}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ entryId: "message-id" }),
      });
      expect(response.status).toBe(404);
    }
  });

  it("streams a Claude Code run, persists its projection, and resumes by native id", async () => {
    const appRuntime = runtime();
    const metadata = appRuntime.claudeSessions.create({
      title: "Claude",
      snapshot: {
        agentId: "claude-reader",
        agentName: "Claude Reader",
        runtime: "claude-code",
        systemPrompt: "Read only",
        provider: null,
        model: null,
        reasoningEffort: null,
      },
    });
    const executable = path.join(path.dirname(appRuntime.claudeSessions.root), "fake-claude.mjs");
    fs.writeFileSync(executable, `#!/usr/bin/env node
console.log(JSON.stringify({type:"system",session_id:"11111111-1111-4111-8111-111111111111"}));
console.log(JSON.stringify({type:"assistant",message:{model:"claude",content:[{type:"text",text:"Market is calm."}],usage:{input_tokens:8,output_tokens:3}}}));
console.log(JSON.stringify({type:"result",session_id:"11111111-1111-4111-8111-111111111111",result:"Market is calm.",is_error:false}));
`);
    fs.chmodSync(executable, 0o755);
    const previous = process.env.TRADEX_CLAUDE_PATH;
    process.env.TRADEX_CLAUDE_PATH = executable;
    try {
      const response = await agentRoutes(appRuntime).request(`/api/agent/sessions/${metadata.id}/messages/stream`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: "Analyze" }),
      });
      const body = await response.text();

      expect(response.status).toBe(200);
      expect(body).toContain('"type":"message_update"');
      expect(body).toContain("Market is calm.");
      expect(body).toContain('"type":"session_update"');
      expect(appRuntime.claudeSessions.getMetadata(metadata.id)?.nativeSessionId).toBe("11111111-1111-4111-8111-111111111111");
      expect(appRuntime.claudeSessions.messages(metadata.id).map((message) => message.role)).toEqual(["user", "assistant"]);
    } finally {
      if (previous === undefined) delete process.env.TRADEX_CLAUDE_PATH;
      else process.env.TRADEX_CLAUDE_PATH = previous;
    }
  });

  it("keeps the Tradex projection when native Claude project purge fails", async () => {
    const appRuntime = runtime();
    const metadata = appRuntime.claudeSessions.create({
      title: "Claude",
      snapshot: {
        agentId: "claude-reader", agentName: "Claude Reader", runtime: "claude-code",
        systemPrompt: "Read only", provider: null, model: null, reasoningEffort: null,
      },
    });
    const executable = path.join(path.dirname(appRuntime.claudeSessions.root), "failing-claude.mjs");
    fs.writeFileSync(executable, "#!/usr/bin/env node\nprocess.exit(9);\n");
    fs.chmodSync(executable, 0o755);
    const previous = process.env.TRADEX_CLAUDE_PATH;
    process.env.TRADEX_CLAUDE_PATH = executable;
    try {
      const response = await agentRoutes(appRuntime).request(`/api/agent/sessions/${metadata.id}`, { method: "DELETE" });
      expect(response.status).toBe(502);
      expect(appRuntime.claudeSessions.getMetadata(metadata.id)).not.toBeNull();
    } finally {
      if (previous === undefined) delete process.env.TRADEX_CLAUDE_PATH;
      else process.env.TRADEX_CLAUDE_PATH = previous;
    }
  });
});
