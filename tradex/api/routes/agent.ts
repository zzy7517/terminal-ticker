/** 提供 Agent/Session REST API，并把运行请求分发给对应 Runtime。 */
import { Hono } from "hono";
import { AgentModelRegistry } from "../../agent/runtime/pi/models/registry.js";
import {
  createPiSession,
  deletePiSession,
  AGENT_SNAPSHOT_ENTRY,
  appendAgentSnapshot,
  readAgentSnapshot,
  listPiSessionManagersSync,
  piProviderName,
  piSessionPayload,
} from "../../agent/runtime/pi/sessions.js";
import type { AgentDefinition, AgentFileInput } from "../../agent/agent_store.js";
import { updateAgentConfigInWatchlist } from "../../config/watchlist_store.js";
import type { ImageContent } from "@earendil-works/pi-ai";
import { MAIN_AGENT_PROMPT } from "../../agent/prompts.js";
import { CLAUDE_CODE_CAPABILITIES, PI_SDK_CAPABILITIES } from "../../agent/runtime/capabilities.js";
import { detectClaudeCode } from "../../agent/runtime/claude-code/discovery.js";
import { claudeModelCatalog } from "../../agent/runtime/claude-code/model-manifest.js";
import { purgeClaudeProject } from "../../agent/runtime/claude-code/runtime.js";
import type { AppRuntime } from "../runtime.js";
import { streamClaudeSession, validateClaudeImages } from "../claude-session-stream.js";
import { streamPiSession } from "../pi-session-stream.js";
import {
  idleRun,
  openSessionManager,
  sessionResponse,
  sessionHistory,
  agentConfigForRequest,
  requireConfigPath,
  reloadAndState,
  mergeProviderProfile,
  apiModeForProvider,
  normalizeModelOption,
} from "../helpers.js";

export function agentRoutes(runtime: AppRuntime): Hono {
  const app = new Hono();

  app.get("/api/agents", (c) => c.json({ agents: runtime.agentStore.list() }));

  app.get("/api/chat/agents/:agentId/messages", (c) => {
    const agentId = c.req.param("agentId");
    if (!runtime.agentStore.get(agentId)) return c.json({ detail: "Agent not found" }, 404);
    runtime.agentContextManager.ensure(agentId);
    const dm = runtime.messageStore.requireHumanAgentDm(agentId);
    const beforeSeq = Number(c.req.query("before_seq"));
    const limit = Number(c.req.query("limit"));
    const page = runtime.messageStore.listMessages({
      directMessageId: dm.id,
      beforeSeq: Number.isFinite(beforeSeq) && beforeSeq > 0 ? beforeSeq : null,
      limit: Number.isFinite(limit) && limit > 0 ? limit : 50,
    });
    return c.json({
      directMessage: dm,
      target: { kind: "direct-message", directMessageId: dm.id },
      ...page,
      generations: runtime.agentContextManager.listSessions(agentId),
    });
  });

  app.post("/api/chat/agents/:agentId/messages", async (c) => {
    const agentId = c.req.param("agentId");
    if (!runtime.agentStore.get(agentId)) return c.json({ detail: "Agent not found" }, 404);
    try {
      const body = await c.req.json() as Record<string, unknown>;
      const content = String(body.content ?? body.message ?? "").trim();
      if (!content) return c.json({ detail: "content is required" }, 400);
      runtime.agentContextManager.ensure(agentId);
      const { appendHumanDmAndNotify } = await import("../../chat/dispatch.js");
      const { message, directMessageId } = appendHumanDmAndNotify(runtime, {
        agentId,
        content,
        threadRootId: typeof body.threadRootId === "string" ? body.threadRootId : null,
      });
      return c.json({
        message,
        directMessage: runtime.messageStore.getConversation(directMessageId),
        target: { kind: "direct-message", directMessageId },
      }, 201);
    } catch (error) {
      return c.json({ detail: error instanceof Error ? error.message : "Message send failed" }, 400);
    }
  });

  app.get("/api/chat/agents/status", (c) => {
    const agents = runtime.agentStore.list().map((agent) => ({
      agentId: agent.id,
      ...runtime.agentCoordinator?.presence(agent.id) ?? { status: "offline", paused: false, running: false },
    }));
    return c.json({ agents });
  });

  app.post("/api/chat/agents/:id/pause", async (c) => {
    await runtime.agentCoordinator?.pause(c.req.param("id"));
    return c.json({ ok: true });
  });
  app.post("/api/chat/agents/:id/resume", async (c) => {
    await runtime.agentCoordinator?.resume(c.req.param("id"));
    return c.json({ ok: true });
  });
  app.post("/api/chat/agents/:id/abort", async (c) => {
    await runtime.agentCoordinator?.abort(c.req.param("id"));
    return c.json({ ok: true });
  });

  app.get("/api/agent/runtimes", async (c) => c.json({
    runtimes: [
      {
        id: "pi",
        available: true,
        version: null,
        error: null,
        capabilities: PI_SDK_CAPABILITIES,
      },
      { ...await detectClaudeCode(), capabilities: CLAUDE_CODE_CAPABILITIES },
    ],
  }));

  app.get("/api/agent/runtimes/claude-code/models", (c) => c.json({
    models: claudeModelCatalog(),
    supportsCustomModel: true,
  }));

  app.post("/api/agents", async (c) => {
    try {
      const body = await c.req.json() as AgentFileInput;
      const agent = runtime.agentStore.create(body);
      runtime.agentContextManager.ensure(agent.id);
      runtime.messageStore.ensureHumanAgentDm(agent.id);
      return c.json({ agent, agents: runtime.agentStore.list() }, 201);
    } catch (error) {
      return c.json({ detail: error instanceof Error ? error.message : "Agent create failed" }, 400);
    }
  });

  app.put("/api/agents/:id", async (c) => {
    try {
      const body = await c.req.json() as Partial<AgentFileInput>;
      if (typeof body.id === "string" && body.id !== c.req.param("id")) {
        return c.json({ detail: "Agent id cannot be changed" }, 400);
      }
      const agent = runtime.agentStore.update(c.req.param("id"), body);
      return c.json({ agent, agents: runtime.agentStore.list() });
    } catch (error) {
      return c.json({ detail: error instanceof Error ? error.message : "Agent update failed" }, 400);
    }
  });

  app.delete("/api/agents/:id", (c) => {
    const agentId = c.req.param("id");
    try {
      runtime.agentStore.remove(agentId, (candidateId) => (
        runtime.agentContextManager.hasSessionsForAgent(candidateId)
        ||
        runtime.claudeSessions.hasPersistedSessionForAgent(candidateId)
        || [...runtime.pendingAgentSnapshots.values()].some((snapshot) => snapshot.agentId === candidateId)
        || listPiSessionManagersSync().some((manager) => {
          return readAgentSnapshot(manager).agentId === candidateId;
        })
      ));
      return c.json({ agents: runtime.agentStore.list() });
    } catch (error) {
      const detail = error instanceof Error ? error.message : "Agent delete failed";
      return c.json({ detail }, detail === "Agent has persisted Sessions" ? 409 : 400);
    }
  });

  // Lists all persisted agent sessions with summary metadata.
  app.get("/api/agent/sessions", async (c) => c.json(await sessionHistory(runtime)));

  // Creates a new agent session and returns it alongside the updated history.
  app.post("/api/agent/sessions", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const agentId = typeof body.agentId === "string" && body.agentId ? body.agentId : "default";
    const selectedAgent = runtime.agentStore.get(agentId);
    if (!selectedAgent) return c.json({ detail: "Agent not found" }, 404);
    if (agentHasLockedSession(runtime, agentId)) {
      return c.json({ detail: "cannot create a Session while Agent is running" }, 409);
    }
    runtime.agentContextManager.ensure(agentId);
    runtime.messageStore.ensureHumanAgentDm(agentId);
    const snapshot = snapshotForAgent(selectedAgent, runtime);
    if (snapshot.runtime === "claude-code") {
      const metadata = runtime.claudeSessions.create({
        title: String(body.title || "New Agent Session"),
        snapshot,
      });
      runtime.agentContextManager.attachSession(agentId, { sessionId: metadata.id, runtime: "claude-code" });
      return c.json({
        ...await sessionResponse(runtime, metadata.id),
        history: await sessionHistory(runtime),
      });
    }
    const mgr = createPiSession({
      title: String(body.title || "New Agent Session"),
    });
    mgr.appendModelChange(
      piProviderName(String(body.provider || snapshot.provider)),
      String(body.model || snapshot.model),
    );
    mgr.appendThinkingLevelChange(snapshot.reasoningEffort);
    runtime.pendingSessionManagers.set(mgr.getSessionId(), mgr);
    runtime.pendingAgentSnapshots.set(mgr.getSessionId(), snapshot);
    runtime.agentContextManager.attachSession(agentId, { sessionId: mgr.getSessionId(), runtime: "pi" });
    const payload = piSessionPayload(mgr);
    payload.session = {
      ...(payload.session as Record<string, unknown>),
      agentId: snapshot.agentId,
      agentName: snapshot.agentName,
      runtime: snapshot.runtime,
      capabilities: PI_SDK_CAPABILITIES,
    };
    const sessionResp = { ...payload, run: idleRun(mgr.getSessionId()) };
    return c.json({
      ...sessionResp,
      history: await sessionHistory(runtime),
    });
  });

  // Returns the full message history for a single agent session.
  app.get("/api/agent/sessions/:id", async (c) => {
    return c.json(await sessionResponse(runtime, c.req.param("id")));
  });

  // Deletes a session from disk and evicts it from the pending map.
  app.delete("/api/agent/sessions/:id", async (c) => {
    const sessionId = c.req.param("id");
    if (runtime.lockedAgentSessions.has(sessionId)) {
      return c.json({ detail: "cannot delete a running session" }, 409);
    }
    runtime.lockedAgentSessions.add(sessionId);
    try {
      const claude = runtime.claudeSessions.getMetadata(sessionId);
      if (claude) {
        await purgeClaudeProject(
          process.env.TRADEX_CLAUDE_PATH?.trim() || "claude",
          runtime.claudeSessions.sessionDir(sessionId),
        );
        runtime.claudeSessions.removeFiles(sessionId);
      } else {
        runtime.pendingSessionManagers.delete(sessionId);
        runtime.pendingAgentSnapshots.delete(sessionId);
        await deletePiSession(sessionId);
      }
      runtime.agentContextManager.removeSession(sessionId);
      return c.json({ session: { session: null, messages: [] }, history: await sessionHistory(runtime), state: await runtime.state() });
    } catch (error) {
      return c.json({ detail: error instanceof Error ? error.message : String(error) }, 502);
    } finally {
      runtime.lockedAgentSessions.delete(sessionId);
    }
  });

  // Streams an agent run as SSE using the new stateful Agent from core/.
  app.post("/api/agent/sessions/:id/messages/stream", async (c) => {
    const sessionId = c.req.param("id");
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const message = String(body.message || "").trim();

    // Parse image attachments from request body
    const rawImages = Array.isArray(body.images) ? body.images : [];
    const requestImages: ImageContent[] = rawImages
      .filter((img): img is { data: string; mimeType: string } =>
        img != null && typeof img === "object" &&
        typeof (img as Record<string, unknown>).data === "string" &&
        typeof (img as Record<string, unknown>).mimeType === "string"
      )
      .map((img) => ({ type: "image" as const, data: img.data, mimeType: img.mimeType }));

    // Allow image-only sends ("paste a screenshot and hit enter") but reject
    // calls with no content at all.
    if (!message && requestImages.length === 0) {
      return c.json({ detail: "message or images is required" }, 400);
    }

    // Prefer Shared Message Fabric for Human-Agent DM text turns when agent context is known.
    const context = runtime.agentContextManager.contextForSession(sessionId);
    if (context && message && requestImages.length === 0) {
      const { appendHumanDmAndNotify } = await import("../../chat/dispatch.js");
      const { message: shared, directMessageId } = appendHumanDmAndNotify(runtime, {
        agentId: context.agentId,
        content: message,
      });
      return c.json({
        ok: true,
        mode: "shared-message",
        message: shared,
        directMessage: runtime.messageStore.getConversation(directMessageId),
      });
    }

    const claudeMetadata = runtime.claudeSessions.getMetadata(sessionId);
    if (claudeMetadata) {
      const imageError = validateClaudeImages(requestImages);
      if (imageError) return c.json({ detail: imageError }, 400);
      return streamClaudeSession({
        runtime,
        requestUrl: c.req.url,
        sessionId,
        message,
        requestImages,
      });
    }
    const mgr = await openSessionManager(sessionId, runtime);
    if (!mgr) {
      return c.json({ detail: "agent session not found" }, 404);
    }
    let agentSnapshot = readAgentSnapshot(mgr);
    const hasSnapshot = mgr.getEntries().some((entry) => entry.type === "custom" && entry.customType === AGENT_SNAPSHOT_ENTRY);
    if (!hasSnapshot) {
      const defaultAgent = runtime.agentStore.get("default")!;
      const fallback = {
        agentId: defaultAgent.id,
        agentName: defaultAgent.name,
        runtime: "pi" as const,
        systemPrompt: defaultAgent.systemPrompt?.trim() || runtime.config.agent.systemPrompt.trim() || MAIN_AGENT_PROMPT,
        provider: runtime.config.agent.provider,
        model: runtime.config.agent.model,
        reasoningEffort: runtime.config.agent.reasoningEffort,
      };
      agentSnapshot = runtime.pendingAgentSnapshots.get(sessionId) ?? fallback;
      appendAgentSnapshot(mgr, agentSnapshot);
      runtime.pendingAgentSnapshots.delete(sessionId);
    }

    const requestConfig = agentConfigForRequest(runtime.config.agent, {
      ...body,
      provider: typeof body.provider === "string" && body.provider ? body.provider : agentSnapshot.provider,
      model: typeof body.model === "string" && body.model ? body.model : agentSnapshot.model,
    });
    requestConfig.reasoningEffort = typeof body.reasoningEffort === "string" && body.reasoningEffort.trim()
      ? body.reasoningEffort.trim()
      : mgr.buildSessionContext().thinkingLevel || agentSnapshot.reasoningEffort || requestConfig.reasoningEffort;
    return streamPiSession({
      runtime,
      sessionId,
      message,
      requestImages,
      manager: mgr,
      snapshot: agentSnapshot,
      requestConfig,
    });
  });

  // Aborts the currently-running agent for a session.
  app.post("/api/agent/sessions/:id/abort", async (c) => {
    const sessionId = c.req.param("id");
    const agent = runtime.activeAgents.get(sessionId);
    if (!agent) {
      return c.json({ detail: "no active agent run for this session" }, 409);
    }
    agent.abort();
    return c.json({ ok: true });
  });

  // Exposes the immutable Pi catalog projection without credential material.
  app.get("/api/agent/model-registry", (c) => {
    return c.json(runtime.modelRuntimeSnapshot.toDTO());
  });

  app.post("/api/agent/model-registry/resolve", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const provider = typeof body.provider === "string" ? body.provider : "";
    const id = typeof body.id === "string"
      ? body.id
      : typeof body.model === "string"
        ? body.model
        : "";
    if (!provider.trim() || !id.trim()) {
      return c.json({ detail: "provider and id are required" }, 400);
    }
    try {
      const snapshot = runtime.modelRuntimeSnapshot;
      return c.json({
        generation: snapshot.generation,
        model: snapshot.resolveSelection({ provider, id }),
      });
    } catch (error) {
      return c.json({ detail: error instanceof Error ? error.message : String(error) }, 404);
    }
  });

  // Lists available models for the given provider, annotated with the active model.
  app.get("/api/agent/providers/:provider/models", async (c) => {
    const provider = c.req.param("provider");
    const profile = runtime.config.agent.providerProfiles[provider];
    try {
      const registry = new AgentModelRegistry(runtime.modelRuntimeSnapshot);
      const models = await registry.listAvailableModels(runtime.config.agent, provider);
      return c.json({
        provider,
        apiMode: apiModeForProvider(provider, profile?.api),
        activeModel: profile?.models[0] ?? runtime.config.agent.model,
        models: models.map(normalizeModelOption),
      });
    } catch (error) {
      return c.json({ detail: error instanceof Error ? error.message : String(error) }, 502);
    }
  });

  // Persists an updated provider profile (enabled flag, model list, API key, etc.)
  // and reloads config so the change takes effect immediately.
  app.post("/api/agent/providers/:provider", async (c) => {
    const provider = c.req.param("provider");
    const body = (await c.req.json()) as Record<string, unknown>;
    const watchlistPath = requireConfigPath(runtime);
    await updateAgentConfigInWatchlist(watchlistPath, mergeProviderProfile(runtime.config.agent, provider, body));
    return c.json({ state: await reloadAndState(runtime, watchlistPath) });
  });

  // Updates top-level agent config fields (enabled, maxCandles) and reloads.
  app.post("/api/agent/config", async (c) => {
    const body = (await c.req.json()) as Record<string, unknown>;
    const watchlistPath = requireConfigPath(runtime);
    await updateAgentConfigInWatchlist(watchlistPath, {
      ...runtime.config.agent,
      enabled: typeof body.enabled === "boolean" ? body.enabled : runtime.config.agent.enabled,
      systemPrompt: typeof body.systemPrompt === "string" ? body.systemPrompt.trim() : runtime.config.agent.systemPrompt,
      maxCandles: Number.isFinite(Number(body.maxCandles)) ? Number(body.maxCandles) : runtime.config.agent.maxCandles,
      candleContextMode:
        body.candleContextMode === "raw" || body.candleContextMode === "with_indicators"
          ? body.candleContextMode
          : runtime.config.agent.candleContextMode,
    });
    return c.json({ state: await reloadAndState(runtime, watchlistPath) });
  });

  return app;
}

function agentHasLockedSession(runtime: AppRuntime, agentId: string): boolean {
  return [...runtime.lockedAgentSessions].some((sessionId) => (
    runtime.agentContextManager.contextForSession(sessionId)?.agentId === agentId
    || runtime.pendingAgentSnapshots.get(sessionId)?.agentId === agentId
    || runtime.claudeSessions.getMetadata(sessionId)?.snapshot.agentId === agentId
  ));
}

function snapshotForAgent(agent: AgentDefinition, runtime: AppRuntime) {
  const defaultConfig = runtime.config.agent;
  if (agent.runtime === "claude-code") {
    return {
      agentId: agent.id,
      agentName: agent.name,
      runtime: "claude-code" as const,
      systemPrompt: agent.systemPrompt?.trim() || defaultConfig.systemPrompt.trim() || MAIN_AGENT_PROMPT,
      provider: null,
      model: agent.model,
      reasoningEffort: agent.reasoningEffort,
    };
  }
  return {
    agentId: agent.id,
    agentName: agent.name,
    runtime: "pi" as const,
    systemPrompt: agent.systemPrompt?.trim() || defaultConfig.systemPrompt.trim() || MAIN_AGENT_PROMPT,
    provider: agent.provider || defaultConfig.provider,
    model: agent.model || defaultConfig.model,
    reasoningEffort: agent.reasoningEffort || defaultConfig.reasoningEffort,
  };
}
