import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentStore } from "../../agent/agent-store.js";
import { AgentContextStore } from "../../agent/context-store.js";

import { MessageStore } from "../../chat/message-store.js";
import { InboxStore } from "../../chat/inbox-store.js";
import { UnreadStore } from "../../chat/unread-store.js";
import { agentRoutes } from "./agent.js";
import type { AppRuntime } from "../runtime.js";
import { piSessionFileExists } from "../../agent/runtime/pi/sessions.js";
import { ClaudeSessionStore } from "../../agent/runtime/claude-code/session-store.js";
import { CursorSessionStore } from "../../agent/runtime/cursor/session-store.js";
import { CliRunGrantStore } from "../../agent/runtime/cli-tools.js";
import { promptWithAttachments } from "../external-cli-turn.js";
import { AgentSkillCatalog } from "../../agent/skills.js";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));

function runtime(): AppRuntime {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tradex-agent-api-"));
  dirs.push(dir);
  const agentStore = new AgentStore(dir);
  const dbPath = path.join(dir, "chat.sqlite3");
  const contextStore = new AgentContextStore(dbPath);
  agentStore.create({
    id: "ict",
    name: "ICT 理论分析",
    description: "ICT",
    systemPrompt: "ICT prompt",
    runtime: "pi",
    provider: "codex",
    model: "gpt-5.4",
    reasoningEffort: null,
  });
  return {
    agentStore,
    agentContexts: contextStore,
    messageStore: new MessageStore(dbPath),
    inboxStore: new InboxStore(dbPath),
    unreadStore: new UnreadStore(dbPath),
    agentCoordinator: null,
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
    cursorSessions: new CursorSessionStore(path.join(dir, "cursor-sessions")),
    cliRunGrants: new CliRunGrantStore(),
    skillCatalog: new AgentSkillCatalog(path.join(dir, "skills")),
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
    expect(payload.models).toContainEqual(expect.objectContaining({ id: "claude-opus-4-8", default: true, thinking: expect.any(Object) }));
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

  it("freezes Session routing from the Agent snapshot and ignores body provider/model", async () => {
    const appRuntime = runtime();
    const response = await agentRoutes(appRuntime).request("/api/agent/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        agentId: "ict",
        provider: "anthropic",
        model: "claude-opus-4-6",
      }),
    });
    const payload = await response.json() as { session: { provider: string; model: string } };
    expect(response.status).toBe(200);
    expect(payload.session).toMatchObject({ provider: "openai-codex", model: "gpt-5.4" });
  });

  it("rejects changing a bound Agent provider or model", async () => {
    const appRuntime = runtime();
    const response = await agentRoutes(appRuntime).request("/api/agents/ict", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider: "anthropic", model: "claude-opus-4-6" }),
    });
    const payload = await response.json() as { detail: string };
    expect(response.status).toBe(400);
    expect(payload.detail).toContain("cannot be changed after it has been set");
  });

  it("exposes one Direct Message timeline per Agent without New Chat", async () => {
    const appRuntime = runtime();
    const routes = agentRoutes(appRuntime);
    const first = await routes.request("/api/chat/agents/ict/messages");
    const second = await routes.request("/api/chat/agents/ict/messages");
    const firstPayload = await first.json() as { directMessage: { id: string }; messages: unknown[] };
    const secondPayload = await second.json() as { directMessage: { id: string } };

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(secondPayload.directMessage.id).toBe(firstPayload.directMessage.id);
    expect(firstPayload.messages).toEqual([]);
  });

  it("appends Human DM messages into Shared Message Store", async () => {
    const appRuntime = runtime();
    const routes = agentRoutes(appRuntime);
    const send = await routes.request("/api/chat/agents/ict/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "hello cindy" }),
    });
    const timeline = await routes.request("/api/chat/agents/ict/messages");
    const payload = await timeline.json() as { messages: Array<{ content: string; authorType: string }> };

    expect(send.status).toBe(201);
    expect(payload.messages).toEqual([
      expect.objectContaining({ content: "hello cindy", authorType: "human" }),
    ]);
  });

  it("lists invocable skills and persists selected names outside the DM body", async () => {
    const appRuntime = runtime();
    const skillDir = path.join(appRuntime.skillCatalog.root, "think");
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, "SKILL.md"), "---\nname: think\ndescription: Plan carefully\n---\nThink body\n");
    const routes = agentRoutes(appRuntime);

    const catalog = await routes.request("/api/agent/skills");
    expect(await catalog.json()).toEqual({
      skills: [{ name: "think", displayName: "Think", description: "Plan carefully" }],
    });
    await routes.request("/api/chat/agents/ict/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "$think plan this", skillNames: ["think"] }),
    });
    expect(appRuntime.inboxStore.listPending("ict")[0]?.skillNames).toEqual(["think"]);
    const dm = appRuntime.messageStore.requireHumanAgentDm("ict");
    expect(appRuntime.messageStore.listMessages({ directMessageId: dm.id }).messages[0]?.content)
      .toBe("$think plan this");
  });

  it("supports Human reactions on Direct Message timeline", async () => {
    const appRuntime = runtime();
    const routes = agentRoutes(appRuntime);
    const send = await routes.request("/api/chat/agents/ict/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "scan btc" }),
    });
    const sent = await send.json() as { message: { id: string } };
    const reaction = await routes.request(`/api/chat/agents/ict/messages/${sent.message.id}/reactions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ emoji: "👍" }),
    });
    const payload = await reaction.json() as {
      message: { reactions: Array<{ emoji: string; count: number; reacted: boolean }> };
    };

    expect(reaction.status).toBe(201);
    expect(payload.message.reactions).toEqual([{ emoji: "👍", count: 1, reacted: true }]);
  });

  it("binds Sessions to Agent Context and rejects concurrent session create while running", async () => {
    const appRuntime = runtime();
    const routes = agentRoutes(appRuntime);
    const sessionResponse = await routes.request("/api/agent/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agentId: "ict" }),
    });
    const session = await sessionResponse.json() as { session: { id: string } };

    expect(appRuntime.agentContexts.get("ict")?.activeSessionId).toBe(session.session.id);
    appRuntime.lockedAgentSessions.add(session.session.id);
    const conflict = await routes.request("/api/agent/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agentId: "ict" }),
    });
    expect(conflict.status).toBe(409);
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

  it("deletes an Agent with only context and no Sessions", async () => {
    const appRuntime = runtime();
    const routes = agentRoutes(appRuntime);
    appRuntime.agentContexts.ensure("ict");

    const response = await routes.request("/api/agents/ict", { method: "DELETE" });

    expect(response.status).toBe(200);
    expect(appRuntime.agentStore.get("ict")).toBeNull();
  });

  it("clears the current Session binding when its Session is deleted", async () => {
    const appRuntime = runtime();
    const routes = agentRoutes(appRuntime);
    const created = await routes.request("/api/agent/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agentId: "ict" }),
    });
    const payload = await created.json() as { session: { id: string } };

    const response = await routes.request(`/api/agent/sessions/${payload.session.id}`, { method: "DELETE" });

    expect(response.status).toBe(200);
    expect(appRuntime.agentContexts.get("ict")?.activeSessionId).toBeNull();
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

  it("creates a Cursor CLI Session without adding it to the Pi provider registry", async () => {
    const appRuntime = runtime();
    appRuntime.agentStore.create({
      id: "cursor-reader",
      name: "Cursor Reader",
      description: "Local Cursor CLI",
      systemPrompt: "Read-only analysis",
      runtime: "cursor",
      provider: null,
      model: "composer-2.5",
      reasoningEffort: null,
    });

    const response = await agentRoutes(appRuntime).request("/api/agent/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agentId: "cursor-reader" }),
    });
    const payload = await response.json() as { session: Record<string, unknown> };

    expect(response.status).toBe(200);
    expect(payload.session).toMatchObject({
      runtime: "cursor",
      provider: null,
      model: "composer-2.5",
      agentId: "cursor-reader",
    });
    expect(appRuntime.pendingSessionManagers.size).toBe(0);
    expect(appRuntime.cursorSessions.getMetadata(String(payload.session.id))).not.toBeNull();
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

  it.each([
    {
      name: "malformed base64",
      images: [{ data: "A", mimeType: "image/png" }],
      detail: "image data must be valid base64",
    },
    {
      name: "more than ten images",
      images: Array.from({ length: 11 }, () => ({ data: "YQ==", mimeType: "image/png" })),
      detail: "at most 10 images are allowed",
    },
    {
      name: "an oversized cumulative payload",
      images: Array.from({ length: 2 }, () => ({
        data: Buffer.alloc(13 * 1024 * 1024).toString("base64"),
        mimeType: "image/png",
      })),
      detail: "images must be at most 25 MB in total",
    },
  ])("applies the shared image contract to Pi Agent runs: $name", async ({ images, detail }) => {
    const appRuntime = runtime();
    const routes = agentRoutes(appRuntime);
    const created = await routes.request("/api/agent/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agentId: "ict" }),
    });
    const payload = await created.json() as { session: { id: string } };

    const response = await routes.request(`/api/agent/sessions/${payload.session.id}/messages/stream`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        message: "inspect",
        images,
      }),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ detail });
    expect(appRuntime.lockedAgentSessions.has(payload.session.id)).toBe(false);
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
    appRuntime.agentContexts.attachSession("claude-reader", {
      sessionId: metadata.id,
      runtime: "claude-code",
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
      // Shared-message path for known Agent Context text turns.
      expect(response.status).toBe(200);
      const payload = await response.json() as { mode?: string; message?: { content: string } };
      expect(payload.mode).toBe("shared-message");
      expect(payload.message?.content).toBe("Analyze");
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
