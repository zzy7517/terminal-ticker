import { Hono } from "hono";
import crypto from "node:crypto";
import path from "node:path";
import { writeFile } from "node:fs/promises";
import { AgentModelRegistry } from "../../agent/models/registry.js";
import {
  clonePiSession,
  createPiSession,
  deletePiSession,
  EXTERNAL_CONTEXT_ENTRY,
  AGENT_SNAPSHOT_ENTRY,
  appendAgentSnapshot,
  readAgentSnapshot,
  listPiSessionManagersSync,
  forkPiSessionBeforeUser,
  piProviderName,
  piSessionFileExists,
  piSessionPayload,
} from "../../agent/pi_sessions.js";
import type { AgentDefinition, AgentFileInput } from "../../agent/agent_store.js";
import { buildSessionAttachmentTools } from "../../agent/tools/session-attachments.js";
import { updateAgentConfigInWatchlist } from "../../config/watchlist_store.js";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, TextContent, ImageContent, ToolResultMessage, UserMessage } from "@earendil-works/pi-ai";
import { createPiAgentRuntime } from "../../agent/pi_runtime.js";
import { MAIN_AGENT_PROMPT } from "../../agent/prompts.js";
import { purgeClaudeProject } from "../../agent/runtime/claude-purge.js";
import { ClaudeCodeRuntime } from "../../agent/runtime/claude-code.js";
import { detectClaudeCode } from "../../agent/runtime/claude-availability.js";
import { CLAUDE_CODE_CAPABILITIES } from "../../agent/runtime/claude-code.js";
import type { RuntimeEvent } from "../../agent/runtime/types.js";
import { PI_SDK_CAPABILITIES } from "../../agent/runtime/types.js";
import { exposeClaudeReadTools } from "../../agent/tools/claude-policy.js";
import type { AppRuntime } from "../runtime.js";
import { buildTradexToolRegistry } from "../agent_tools.js";
import { AgentSseWriter } from "../agent_sse.js";
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

  app.post("/api/agents", async (c) => {
    try {
      const body = await c.req.json() as AgentFileInput;
      return c.json({ agent: runtime.agentStore.create(body), agents: runtime.agentStore.list() }, 201);
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
    const snapshot = snapshotForAgent(selectedAgent, runtime);
    if (snapshot.runtime === "claude-code") {
      const metadata = runtime.claudeSessions.create({
        title: String(body.title || "New Agent Session"),
        snapshot,
      });
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
        return c.json({ session: { session: null, messages: [] }, history: await sessionHistory(runtime), state: await runtime.state() });
      }
      runtime.pendingSessionManagers.delete(sessionId);
      runtime.pendingAgentSnapshots.delete(sessionId);
      await deletePiSession(sessionId);
      return c.json({ session: { session: null, messages: [] }, history: await sessionHistory(runtime), state: await runtime.state() });
    } catch (error) {
      return c.json({ detail: error instanceof Error ? error.message : String(error) }, 502);
    } finally {
      runtime.lockedAgentSessions.delete(sessionId);
    }
  });

  // =========================================================================
  // Session fork / clone endpoints
  // =========================================================================

  // Fork: creates a NEW session file from the active branch up to a specific
  // user message. Returns the new session + the selected prompt text so the
  // frontend can place it in the editor for modification.
  app.post("/api/agent/sessions/:id/fork", async (c) => {
    const sessionId = c.req.param("id");
    if (runtime.claudeSessions.getMetadata(sessionId)) {
      return c.json({ detail: "Claude Code runtime does not support Session fork" }, 409);
    }
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const entryId = String(body.entryId || "").trim();

    if (!entryId) return c.json({ detail: "entryId is required" }, 400);

    if (runtime.lockedAgentSessions.has(sessionId)) {
      return c.json({ detail: "cannot fork a running session" }, 409);
    }
    runtime.lockedAgentSessions.add(sessionId);
    try {
      const mgr = await openSessionManager(sessionId, runtime);
      if (!mgr) return c.json({ detail: "session not found" }, 404);
      const { manager: newMgr, prompt } = forkPiSessionBeforeUser(mgr, entryId);
      const newSessionId = newMgr.getSessionId();
      runtime.pendingSessionManagers.set(newSessionId, newMgr);
      return c.json({
        ...await sessionResponse(runtime, newSessionId),
        prompt, // The user message text to place in the editor
        history: await sessionHistory(runtime),
      });
    } catch (err) {
      return c.json({ detail: err instanceof Error ? err.message : "fork failed" }, 400);
    } finally {
      runtime.lockedAgentSessions.delete(sessionId);
    }
  });

  // Clone: duplicates the current active branch into a new session file at
  // the current position.
  app.post("/api/agent/sessions/:id/clone", async (c) => {
    const sessionId = c.req.param("id");
    if (runtime.claudeSessions.getMetadata(sessionId)) {
      return c.json({ detail: "Claude Code runtime does not support Session clone" }, 409);
    }
    if (runtime.lockedAgentSessions.has(sessionId)) {
      return c.json({ detail: "cannot clone a running session" }, 409);
    }
    runtime.lockedAgentSessions.add(sessionId);
    try {
      const mgr = await openSessionManager(sessionId, runtime);
      if (!mgr) return c.json({ detail: "session not found" }, 404);
      const leafId = mgr.getLeafId();
      if (!leafId) return c.json({ detail: "cannot clone an empty session" }, 400);
      const newMgr = clonePiSession(mgr, leafId);
      const newSessionId = newMgr.getSessionId();
      runtime.pendingSessionManagers.set(newSessionId, newMgr);
      return c.json({
        ...await sessionResponse(runtime, newSessionId),
        history: await sessionHistory(runtime),
      });
    } catch (err) {
      return c.json({ detail: err instanceof Error ? err.message : "clone failed" }, 400);
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
    if (runtime.lockedAgentSessions.has(sessionId)) {
      return c.json({ detail: "an agent run is already active for this session" }, 409);
    }
    runtime.lockedAgentSessions.add(sessionId);

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

    const runId = crypto.randomUUID();
    let assistantClientId = "";
    const toolCallsById = new Map<string, Record<string, unknown>>();
    const sse = new AgentSseWriter(sessionId, runId);
    const sendFrame = (controller: ReadableStreamDefaultController<Uint8Array>, event: Record<string, unknown>) => sse.send(controller, event);

    const stream = new ReadableStream({
      async start(controller) {
        sendFrame(controller, { type: "agent_start" });

        try {
          const requestConfig = agentConfigForRequest(runtime.config.agent, {
            ...body,
            provider: typeof body.provider === "string" && body.provider ? body.provider : agentSnapshot.provider,
            model: typeof body.model === "string" && body.model ? body.model : agentSnapshot.model,
          });
          requestConfig.reasoningEffort = typeof body.reasoningEffort === "string" && body.reasoningEffort.trim()
            ? body.reasoningEffort.trim()
            : mgr.buildSessionContext().thinkingLevel || agentSnapshot.reasoningEffort || requestConfig.reasoningEffort;
          const modelRuntime = runtime.modelRuntimeSnapshot;

          // ---- Build tools ----
          const { tools, externalContextToolNames } = await buildTradexToolRegistry(runtime, {
            sessionId,
            config: requestConfig,
            includeMemory: true,
            includeExternalMcp: true,
            includeFilesystem: true,
          });

          // Inject memory context into system prompt when available.
          const memoryInstructions = await runtime.memoryPort.getPromptContext();

          // Build stable session date (day-level only for prompt cache stability).
          const now = new Date();
          const sessionDate = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
          const sessionDateLine = `\nSession date: ${sessionDate} (Asia/Shanghai)`;

          const baseSystemPrompt = agentSnapshot.systemPrompt.trim() || MAIN_AGENT_PROMPT;
          const systemPrompt = [baseSystemPrompt, memoryInstructions ?? ""].filter(Boolean).join("\n") + sessionDateLine;

          const agent = await createPiAgentRuntime({
            config: requestConfig,
            modelRuntime,
            systemPrompt,
            tools,
            sessionManager: mgr,
          });

          // ---- Subscribe to agent events ----
          let finalError: string | null = null;
          let totalTokens = 0;
          let promptTokens = 0;
          let totalOutput = 0;
          let totalCacheRead = 0;
          let totalCacheWrite = 0;
          let totalCost = 0;
          let initialUserMessageSeen = false;
          let externalContextRecorded = false;

          agent.subscribe((event) => {
            switch (event.type) {
              case "message_start": {
                const msg = event.message;
                if (msg.role === "assistant") {
                  toolCallsById.clear();
                  assistantClientId = `assistant:${crypto.randomUUID()}`;
                  sendFrame(controller, {
                    type: "message_start",
                    message: {
                      id: assistantClientId,
                      clientId: assistantClientId,
                      sessionId,
                      role: "assistant",
                      content: "",
                      createdAt: new Date().toISOString(),
                      metadata: { toolCalls: [] },
                      error: null,
                      entryId: null,
                      parentId: mgr.getLeafId(),
                      entryType: "message",
                    },
                  });
                }
                break;
              }

              case "message_update": {
                if (event.message.role === "assistant") {
                  // Extract text delta from the fine-grained event for SSE compatibility
                  const evt = event.assistantMessageEvent;
                  let delta = "";
                  if (evt.type === "text_delta") {
                    delta = evt.delta;
                  } else if (evt.type === "thinking_delta") {
                    // Optionally forward thinking deltas (currently not rendered by frontend)
                    delta = "";
                  } else if (evt.type === "toolcall_delta") {
                    // Tool call argument deltas are not streamed to the frontend text
                    delta = "";
                  }
                  if (delta) {
                    sendFrame(controller, {
                      type: "message_update",
                      message: {
                        clientId: assistantClientId,
                        role: "assistant",
                        content: "",
                        metadata: null,
                        error: null,
                      },
                      delta,
                    });
                  }
                }
                break;
              }

              case "tool_execution_start": {
                const toolCall = { id: event.toolCallId, name: event.toolName, arguments: event.args };
                toolCallsById.set(event.toolCallId, toolCall);
                if (
                  !externalContextRecorded &&
                  externalContextToolNames.has(event.toolName)
                ) {
                  externalContextRecorded = true;
                  mgr.appendCustomEntry(EXTERNAL_CONTEXT_ENTRY, {
                    toolName: event.toolName,
                  });
                }
                sendFrame(controller, { type: "tool_execution_start", toolCall });
                break;
              }

              case "tool_execution_end": {
                const toolOutput = event.result.content
                  .filter((c: { type: string }): c is TextContent => c.type === "text")
                  .map((c: TextContent) => c.text)
                  .join("\n");
                // Extract images from tool result for frontend display
                const toolResultImages = event.result.content
                  .filter((c: { type: string }) => c.type === "image")
                  .map((c: { type: string }) => ({ data: (c as ImageContent).data, mimeType: (c as ImageContent).mimeType }));
                sendFrame(controller, {
                  type: "tool_execution_end",
                  toolCall: toolCallsById.get(event.toolCallId) ?? { id: event.toolCallId, name: event.toolName, arguments: {} },
                  toolResult: {
                    callId: event.toolCallId,
                    name: event.toolName,
                    output: toolOutput.slice(0, 2000),
                    error: event.isError,
                    ...(toolResultImages.length > 0 ? { images: toolResultImages } : {}),
                  },
                });
                break;
              }

              case "message_end": {
                const msg = event.message;
                if (msg.role === "user") {
                  if (!initialUserMessageSeen) {
                    initialUserMessageSeen = true;
                    break;
                  }
                  sendFrame(controller, {
                    type: "message_end",
                    message: agentEventMessageDto(sessionId, msg),
                  });
                } else if (msg.role === "toolResult") {
                  sendFrame(controller, {
                    type: "message_end",
                    message: agentEventMessageDto(sessionId, msg),
                  });
                } else if (msg.role === "assistant") {
                  const assistant = msg as AssistantMessage;
                  const turnContent = assistant.content
                    .filter((c): c is TextContent => c.type === "text")
                    .map((c) => c.text)
                    .join("");
                  void runtime.memoryPort.recordAssistantResponse(turnContent);
                  finalError = assistant.errorMessage ?? null;
                  totalTokens += assistant.usage.totalTokens;
                  promptTokens += assistant.usage.input;
                  // Extract tool calls declared in the assistant message content
                  for (const c of assistant.content) {
                    if (c.type === "toolCall") {
                      toolCallsById.set(c.id, { id: c.id, name: c.name, arguments: c.arguments });
                    }
                  }
                  totalOutput += assistant.usage.output;
                  totalCacheRead += assistant.usage.cacheRead;
                  totalCacheWrite += assistant.usage.cacheWrite;
                  totalCost += assistant.usage.cost.total;
                  sendFrame(controller, {
                    type: "message_end",
                    message: agentEventMessageDto(sessionId, msg, assistantClientId),
                  });
                }
                break;
              }

              default:
                break;
            }
          });

          // ---- Register agent for steering/abort ----
          runtime.activeAgents.set(sessionId, agent);

          // ---- Run the agent ----
          await agent.prompt(message, requestImages.length > 0 ? requestImages : undefined);
          if (piSessionFileExists(mgr)) runtime.pendingSessionManagers.delete(sessionId);
          runtime.activeAgents.delete(sessionId);

          sendFrame(controller, {
            type: "agent_end",
            error: finalError,
            totalTokens,
            promptTokens,
            sessionStats: {
              tokens: {
                input: promptTokens,
                output: totalOutput,
                cacheRead: totalCacheRead,
                cacheWrite: totalCacheWrite,
                total: promptTokens + totalOutput + totalCacheRead + totalCacheWrite,
              },
              cost: totalCost,
            },
          });

          sendFrame(controller, {
            type: "session_update",
            session: await sessionResponse(runtime, sessionId),
            history: await sessionHistory(runtime),
            state: await runtime.state(),
          });

        } catch (error) {
          const errorText = error instanceof Error ? error.message : String(error);
          sendFrame(controller, { type: "error", error: errorText });
          sendFrame(controller, { type: "agent_end", error: errorText, totalTokens: 0, promptTokens: 0, sessionStats: null });
        } finally {
          runtime.activeAgents.delete(sessionId);
          runtime.lockedAgentSessions.delete(sessionId);
          if (piSessionFileExists(mgr)) runtime.pendingSessionManagers.delete(sessionId);
          try {
            controller.close();
          } catch {
            // Already closed/cancelled by the client.
          }
        }
      },
      cancel() {
        // Client disconnected (page refresh, tab close, network drop): stop
        // the agent run instead of letting it burn LLM/tool budget unobserved.
        sse.cancel();
        runtime.activeAgents.get(sessionId)?.abort();
      },
    });

    return new Response(stream, { headers: { "Content-Type": "text/event-stream" } });
  });

  // Injects a steering message into an actively-running agent session.
  // The message is queued and will be processed after the current tool turn finishes.
  // Persistence is handled by the event subscriber when the loop processes the message.
  app.post("/api/agent/sessions/:id/steer", async (c) => {
    const sessionId = c.req.param("id");
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const message = String(body.message || "").trim();
    if (!message) {
      return c.json({ detail: "message is required" }, 400);
    }
    const agent = runtime.activeAgents.get(sessionId);
    if (!agent) {
      return c.json({ detail: "no active agent run for this session" }, 409);
    }
    if (!agent.steer) return c.json({ detail: "runtime does not support steering" }, 409);
    agent.steer({ role: "user", content: message, timestamp: Date.now() });
    return c.json({ ok: true });
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

interface ClaudeStreamInput {
  runtime: AppRuntime;
  requestUrl: string;
  sessionId: string;
  message: string;
  requestImages: ImageContent[];
}

async function streamClaudeSession(input: ClaudeStreamInput): Promise<Response> {
  const { runtime, sessionId, requestImages } = input;
  const metadata = runtime.claudeSessions.getMetadata(sessionId);
  if (!metadata) return Response.json({ detail: "agent session not found" }, { status: 404 });
  if (runtime.lockedAgentSessions.has(sessionId)) {
    return Response.json({ detail: "an agent run is already active for this session" }, { status: 409 });
  }
  runtime.lockedAgentSessions.add(sessionId);

  let prompt = input.message;
  try {
    const attachmentPaths = await saveClaudeAttachments(runtime, sessionId, requestImages);
    if (attachmentPaths.length > 0) {
      prompt = [
        prompt,
        "Attached images are available through the read_session_attachment tool:",
        ...attachmentPaths.map((file) => `- ${path.basename(file)}`),
      ].filter(Boolean).join("\n\n");
    }
    runtime.claudeSessions.appendMessage(sessionId, {
      role: "user",
      content: input.message,
      metadata: attachmentPaths.length > 0
        ? { images: requestImages.map((image, index) => ({ mimeType: image.mimeType, filename: path.basename(attachmentPaths[index]) })) }
        : null,
    });
  } catch (error) {
    runtime.lockedAgentSessions.delete(sessionId);
    return Response.json({ detail: error instanceof Error ? error.message : String(error) }, { status: 400 });
  }

  const runId = crypto.randomUUID();
  const sse = new AgentSseWriter(sessionId, runId);
  const sendFrame = (controller: ReadableStreamDefaultController<Uint8Array>, event: Record<string, unknown>) => sse.send(controller, event);

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      sendFrame(controller, { type: "agent_start" });
      let assistantClientId = `assistant:${crypto.randomUUID()}`;
      let assistantStarted = false;
      let assistantText = "";
      let runError: string | null = null;
      let runErrorCode: string | null = null;
      let model = metadata.snapshot.model;
      const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
      const toolCalls = new Map<string, { id: string; name: string; arguments: Record<string, unknown> }>();

      try {
        runtime.claudeSessions.beginRun(sessionId);
        const executablePath = process.env.TRADEX_CLAUDE_PATH?.trim() || "claude";
        const availability = await detectClaudeCode(executablePath);
        if (!availability.available) {
          runErrorCode = "runtime_unavailable";
          throw new Error(availability.error ?? "Claude Code runtime is unavailable");
        }
        const { tools: claudeTools } = await buildTradexToolRegistry(runtime, {
          sessionId,
          config: runtime.config.agent,
          includeMemory: false,
          includeExternalMcp: false,
          includeFilesystem: false,
          additionalRegistries: [buildSessionAttachmentTools(runtime.claudeSessions.sessionDir(sessionId))],
        });
        const tools = exposeClaudeReadTools(claudeTools);
        const nativeSessionId = runtime.claudeSessions.getMetadata(sessionId)?.nativeSessionId ?? undefined;
        const claude = new ClaudeCodeRuntime({
          executablePath: availability.executablePath,
          mcpUrl: claudeMcpUrl(input.requestUrl),
          grants: runtime.mcpRunGrants,
        });
        const run = await claude.start({
          tradexSessionId: sessionId,
          cwd: runtime.claudeSessions.sessionDir(sessionId),
          prompt,
          instructions: claudeInstructions(metadata.snapshot.systemPrompt),
          registry: tools,
          nativeSessionId,
          model: metadata.snapshot.model,
          effort: metadata.snapshot.reasoningEffort,
        });
        runtime.activeAgents.set(sessionId, run);
        if (run.nativeSessionId) runtime.claudeSessions.setNativeSessionId(sessionId, run.nativeSessionId);

        const unsubscribe = run.subscribe((event: RuntimeEvent) => {
          if (event.type === "run-start" && event.nativeSessionId) {
            runtime.claudeSessions.setNativeSessionId(sessionId, event.nativeSessionId);
            return;
          }
          if (event.type === "text-delta") {
            if (!assistantStarted) {
              assistantStarted = true;
              sendFrame(controller, {
                type: "message_start",
                message: claudeMessageDto(sessionId, assistantClientId, "", { toolCalls: [] }, null),
              });
            }
            assistantText += event.delta;
            sendFrame(controller, {
              type: "message_update",
              message: { clientId: assistantClientId, role: "assistant", content: "", metadata: null, error: null },
              delta: event.delta,
            });
            return;
          }
          if (event.type === "tool-start") {
            const toolCall = { id: event.callId, name: event.name, arguments: event.args };
            toolCalls.set(event.callId, toolCall);
            sendFrame(controller, { type: "tool_execution_start", toolCall });
            return;
          }
          if (event.type === "tool-end") {
            const toolName = toolCalls.get(event.callId)?.name ?? "unknown";
            runtime.claudeSessions.appendMessage(sessionId, {
              role: "toolResult",
              content: event.output,
              metadata: { toolCallId: event.callId, toolName, error: event.isError },
              error: event.isError ? event.output : null,
            });
            sendFrame(controller, {
              type: "tool_execution_end",
              toolCall: toolCalls.get(event.callId) ?? { id: event.callId, name: "unknown", arguments: {} },
              toolResult: {
                callId: event.callId,
                name: toolName,
                output: event.output.slice(0, 2_000),
                error: event.isError,
              },
            });
            return;
          }
          if (event.type === "usage") {
            model = event.model;
            usage.input += event.input;
            usage.output += event.output;
            usage.cacheRead += event.cacheRead;
            usage.cacheWrite += event.cacheWrite;
          }
        });

        const result = await run.result;
        unsubscribe();
        runError = result.error;
        runErrorCode = result.errorCode ?? null;
        runtime.claudeSessions.endRun(sessionId, {
          status: runErrorCode === "aborted" ? "cancelled" : runError ? "error" : "completed",
          error: runError,
        });
        if (result.nativeSessionId) runtime.claudeSessions.setNativeSessionId(sessionId, result.nativeSessionId);
        if (!assistantText && result.output) assistantText = result.output;
        const persisted = runtime.claudeSessions.appendMessage(sessionId, {
          role: "assistant",
          content: assistantText,
          error: runError,
          metadata: {
            errorCode: runErrorCode,
            model,
            promptTokens: usage.input,
            completionTokens: usage.output,
            cacheRead: usage.cacheRead,
            cacheWrite: usage.cacheWrite,
            totalTokens: usage.input + usage.output + usage.cacheRead + usage.cacheWrite,
            toolCalls: [...toolCalls.values()],
          },
        });
        if (!assistantStarted) {
          assistantStarted = true;
          sendFrame(controller, {
            type: "message_start",
            message: claudeMessageDto(sessionId, assistantClientId, "", { toolCalls: [] }, null),
          });
          if (assistantText) {
            sendFrame(controller, {
              type: "message_update",
              message: { clientId: assistantClientId, role: "assistant", content: "", metadata: null, error: null },
              delta: assistantText,
            });
          }
        }
        sendFrame(controller, { type: "message_end", message: { ...persisted, id: assistantClientId, clientId: assistantClientId } });
        sendFrame(controller, {
          type: "agent_end",
          error: runError,
          errorCode: runErrorCode,
          totalTokens: usage.input + usage.output + usage.cacheRead + usage.cacheWrite,
          promptTokens: usage.input,
          sessionStats: { tokens: { ...usage, total: usage.input + usage.output + usage.cacheRead + usage.cacheWrite }, cost: 0 },
        });
        sendFrame(controller, {
          type: "session_update",
          session: await sessionResponse(runtime, sessionId),
          history: await sessionHistory(runtime),
          state: await runtime.state(),
        });
      } catch (error) {
        runError = error instanceof Error ? error.message : String(error);
        runtime.claudeSessions.endRun(sessionId, { status: "error", error: runError });
        runtime.claudeSessions.appendMessage(sessionId, { role: "assistant", content: assistantText, error: runError });
        sendFrame(controller, { type: "error", code: runErrorCode ?? "runtime_failure", error: runError });
        sendFrame(controller, { type: "agent_end", error: runError, errorCode: runErrorCode, totalTokens: 0, promptTokens: 0, sessionStats: null });
      } finally {
        runtime.activeAgents.delete(sessionId);
        runtime.lockedAgentSessions.delete(sessionId);
        try { controller.close(); } catch { /* stream already cancelled */ }
      }
    },
    cancel() {
      sse.cancel();
      runtime.activeAgents.get(sessionId)?.abort();
    },
  });
  return new Response(stream, { headers: { "Content-Type": "text/event-stream" } });
}

function claudeInstructions(agentInstructions: string): string {
  const now = new Date();
  const sessionDate = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  return [
    MAIN_AGENT_PROMPT,
    ...(agentInstructions.trim() && agentInstructions.trim() !== MAIN_AGENT_PROMPT.trim() ? [agentInstructions.trim()] : []),
    `Session date: ${sessionDate} (Asia/Shanghai).`,
    "You are running inside Tradex via Claude Code. Use only the explicitly allowed Tradex MCP read tools. Read image attachments only with read_session_attachment.",
    "Do not place trades, modify files, use shell commands, access Memory, configure external MCP servers, or claim those capabilities are available.",
  ].join("\n\n");
}

function claudeMcpUrl(requestUrl: string): string {
  const url = new URL(requestUrl);
  const host = url.port ? `127.0.0.1:${url.port}` : "127.0.0.1";
  return `${url.protocol}//${host}/mcp/tradex`;
}

const CLAUDE_IMAGE_TYPES: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
};

function validateClaudeImages(images: ImageContent[]): string | null {
  if (images.length > 10) return "at most 10 images are allowed";
  for (const image of images) {
    if (!CLAUDE_IMAGE_TYPES[image.mimeType]) return `unsupported image type: ${image.mimeType}`;
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(image.data)) return "image data must be valid base64";
    if (Buffer.byteLength(image.data, "base64") > 20 * 1024 * 1024) return "each image must be at most 20 MB";
  }
  return null;
}

async function saveClaudeAttachments(runtime: AppRuntime, sessionId: string, images: ImageContent[]): Promise<string[]> {
  const directory = path.join(runtime.claudeSessions.sessionDir(sessionId), "attachments");
  return Promise.all(images.map(async (image) => {
    const file = path.join(directory, `${crypto.randomUUID()}.${CLAUDE_IMAGE_TYPES[image.mimeType]}`);
    await writeFile(file, Buffer.from(image.data, "base64"), { mode: 0o600 });
    return file;
  }));
}

function claudeMessageDto(
  sessionId: string,
  clientId: string,
  content: string,
  metadata: Record<string, unknown> | null,
  error: string | null,
): Record<string, unknown> {
  return {
    id: clientId,
    clientId,
    sessionId,
    role: "assistant",
    content,
    createdAt: new Date().toISOString(),
    metadata,
    error,
    entryId: null,
    parentId: null,
    entryType: "message",
  };
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

function agentEventMessageDto(
  sessionId: string,
  message: AgentMessage,
  clientId?: string,
): Record<string, unknown> {
  const createdAt = new Date(
    typeof message.timestamp === "number" ? message.timestamp : Date.now(),
  ).toISOString();
  const id = clientId
    ?? (message.role === "toolResult"
      ? `toolResult:${(message as ToolResultMessage).toolCallId}`
      : `${message.role}:${crypto.randomUUID()}`);
  const base = {
    id,
    ...(clientId ? { clientId } : {}),
    sessionId,
    role: message.role,
    createdAt,
    entryId: null,
    parentId: null,
    entryType: "message",
  };

  if (message.role === "user") {
    const user = message as UserMessage;
    return {
      ...base,
      content: eventContentText(user.content),
      metadata: eventImageMetadata(user.content),
      error: null,
    };
  }
  if (message.role === "assistant") {
    const assistant = message as AssistantMessage;
    return {
      ...base,
      content: eventContentText(assistant.content),
      metadata: {
        totalTokens: assistant.usage.totalTokens,
        promptTokens: assistant.usage.input,
        completionTokens: assistant.usage.output,
        cacheRead: assistant.usage.cacheRead,
        cacheWrite: assistant.usage.cacheWrite,
        cost: assistant.usage.cost.total,
        toolCalls: assistant.content
          .filter((item) => item.type === "toolCall")
          .map((item) => ({
            id: item.id,
            name: item.name,
            arguments: item.arguments,
          })),
      },
      error: assistant.errorMessage ?? null,
    };
  }
  if (message.role === "toolResult") {
    const result = message as ToolResultMessage;
    return {
      ...base,
      content: eventContentText(result.content),
      metadata: {
        toolCallId: result.toolCallId,
        toolName: result.toolName,
        error: result.isError,
        ...(eventImageMetadata(result.content) ?? {}),
      },
      error: result.isError ? eventContentText(result.content) : null,
    };
  }
  return { ...base, content: "", metadata: null, error: null };
}

function eventContentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((item): item is TextContent =>
      Boolean(item && typeof item === "object" && (item as { type?: unknown }).type === "text")
    )
    .map((item) => item.text)
    .join("");
}

function eventImageMetadata(content: unknown): Record<string, unknown> | null {
  if (!Array.isArray(content)) return null;
  const images = content
    .filter((item): item is ImageContent =>
      Boolean(item && typeof item === "object" && (item as { type?: unknown }).type === "image")
    )
    .map((item) => ({ data: item.data, mimeType: item.mimeType }));
  return images.length > 0 ? { images } : null;
}
