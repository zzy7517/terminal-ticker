import { Hono } from "hono";
import crypto from "node:crypto";
import { DEFAULT_AGENT_MODEL_REGISTRY } from "../../agent/model_registry.js";
import {
  clonePiSession,
  createPiSession,
  deletePiSession,
  EXTERNAL_CONTEXT_ENTRY,
  forkPiSessionBeforeUser,
  piProviderName,
  piSessionFileExists,
  piSessionPayload,
} from "../../agent/pi_sessions.js";
import { buildMarketTools } from "../../agent/tools/market.js";
import { buildNewsTools } from "../../agent/tools/news.js";
import { buildJin10Tools } from "../../agent/tools/jin10.js";
import { buildSocialFeedTools } from "../../agent/tools/social.js";
import { buildTradingTools } from "../../agent/tools/trading.js";
import { buildWebTools } from "../../agent/tools/web.js";
import { buildBrowserTools } from "../../agent/tools/browser.js";
import { buildOptionsTools } from "../../agent/tools/options.js";
import { createFilesystemRegistry, setFilesystemRoot } from "../../agent/tools/filesystem.js";
import { mergeRegistries } from "../../agent/tools/registry.js";
import { buildMcpToolRegistry } from "../../mcp/index.js";
import { updateAgentConfigInWatchlist } from "../../config/watchlist_store.js";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, TextContent, ImageContent, ToolResultMessage, UserMessage } from "@earendil-works/pi-ai";
import { createPiAgentRuntime } from "../../agent/pi_runtime.js";
import { loadSkills, formatSkillsForPrompt } from "../../agent/skills.js";
import { MAIN_AGENT_PROMPT } from "../../agent/prompts.js";
import type { AppRuntime } from "../runtime.js";
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

  // Lists all persisted agent sessions with summary metadata.
  app.get("/api/agent/sessions", async (c) => c.json(await sessionHistory(runtime)));

  // Creates a new agent session and returns it alongside the updated history.
  app.post("/api/agent/sessions", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const mgr = createPiSession({
      title: String(body.title || "New Agent Session"),
    });
    mgr.appendModelChange(
      piProviderName(String(body.provider || runtime.config.agent.provider)),
      String(body.model || runtime.config.agent.model),
    );
    runtime.pendingSessionManagers.set(mgr.getSessionId(), mgr);
    const payload = piSessionPayload(mgr);
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
      runtime.pendingSessionManagers.delete(sessionId);
      await deletePiSession(sessionId);
      return c.json({ session: { session: null, messages: [] }, history: await sessionHistory(runtime), state: await runtime.state() });
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
    const mgr = await openSessionManager(sessionId, runtime);
    if (!mgr) {
      return c.json({ detail: "agent session not found" }, 404);
    }
    if (runtime.lockedAgentSessions.has(sessionId)) {
      return c.json({ detail: "an agent run is already active for this session" }, 409);
    }
    runtime.lockedAgentSessions.add(sessionId);

    const encoder = new TextEncoder();
    const runId = crypto.randomUUID();
    let assistantClientId = "";
    const toolCallsById = new Map<string, Record<string, unknown>>();
    let seq = 0;

    let streamCancelled = false;
    const sendFrame = (controller: ReadableStreamDefaultController<Uint8Array>, event: Record<string, unknown>) => {
      if (streamCancelled) return;
      seq += 1;
      try {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ sessionId, runId, seq, event })}\n\n`));
      } catch {
        // Client went away mid-run; the cancel() hook aborts the agent.
        streamCancelled = true;
      }
    };

    const stream = new ReadableStream({
      async start(controller) {
        sendFrame(controller, { type: "agent_start" });

        try {
          // ---- Load skills ----
          const requestConfig = agentConfigForRequest(runtime.config.agent, body);
          const skillsConfig = runtime.config.agent.skills;
          let skillsPromptBlock = "";
          const allowedSkillPaths = new Set<string>();
          if (skillsConfig.enabled) {
            const { skills: loadedSkills, diagnostics: skillDiagnostics } = loadSkills({
              cwd: process.cwd(),
              skillPaths: skillsConfig.paths,
              includeDefaults: skillsConfig.includeDefaults,
            });
            if (skillDiagnostics.length > 0) {
              for (const d of skillDiagnostics) {
                console.warn(`[skills] ${d.type}: ${d.message} (${d.path})`);
              }
            }
            for (const s of loadedSkills) allowedSkillPaths.add(s.filePath);
            skillsPromptBlock = formatSkillsForPrompt(loadedSkills);
          }

          // ---- Build tools ----
          const mcpRegistry = runtime.mcpManager
            ? await buildMcpToolRegistry(runtime.mcpManager, runtime.mcpManager.getConfig())
            : null;
          const memoryRegistry = await runtime.memoryPort.buildTools();
          const externalContextToolNames = new Set([
            "web_search",
            "web_fetch",
            "get_recent_news",
            "refresh_news",
            "refresh_x_following_feed",
            "get_recent_social_feed",
            "search_x_tweets",
            "browser_open_page",
            "browser_screenshot",
            "browser_status",
            ...(mcpRegistry?.listTools().map((tool) => tool.name) ?? []),
          ]);
          const tools = mergeRegistries(
            buildMarketTools({
              quotes: runtime.controller.quotes,
              maxCandles: requestConfig.maxCandles,
              candleContextMode: requestConfig.candleContextMode,
            }),
            buildNewsTools({
              recent: (limit, sinceMinutes) => runtime.newsService.recent(limit ?? undefined).filter((item) => {
                if (sinceMinutes == null) return true;
                return item.publishedAtMs >= Date.now() - sinceMinutes * 60_000;
              }),
              refresh: () => runtime.newsService.refreshNow(),
            }),
            buildSocialFeedTools({
              refreshFollowing: (count) => runtime.socialFeedService.refreshXFollowing({ count }),
              recent: async (args) => runtime.socialFeedService.recentItems({
                limit: Number(args.limit) || runtime.config.socialFeed.recentLimit,
              }),
              search: async (args) => (await runtime.socialFeedService.searchXTweets({
                query: String(args.query || ""),
                count: Number(args.count) || 20,
                product: typeof args.product === "string" ? args.product : undefined,
              })).items,
            }),
            ...(memoryRegistry ? [memoryRegistry] : []),
            buildTradingTools({
              tradeStore: runtime.tradeStore,
              exchangeRouter: runtime.exchangeRouter,
              tradingConfig: runtime.config.trading,
              resolveSessionId: () => sessionId,
            }),
            buildJin10Tools(runtime.jin10Service),
            buildWebTools(),
            ...(runtime.config.browser.enabled ? [buildBrowserTools(runtime.browserManager)] : []),
            ...(runtime.optionsService ? [buildOptionsTools(runtime)] : []),
            createFilesystemRegistry({ allowedSkillPaths }),
            ...(mcpRegistry ? [mcpRegistry] : []),
          );

          // Inject memory context into system prompt when available.
          const memoryInstructions = await runtime.memoryPort.getPromptContext();

          // Build stable session date (day-level only for prompt cache stability).
          const now = new Date();
          const sessionDate = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
          const sessionDateLine = `\nSession date: ${sessionDate} (Asia/Shanghai)`;

          const baseSystemPrompt = requestConfig.systemPrompt.trim() || MAIN_AGENT_PROMPT;
          const systemPrompt = [baseSystemPrompt, memoryInstructions ?? "", skillsPromptBlock].filter(Boolean).join("\n") + sessionDateLine;

          const agent = await createPiAgentRuntime({
            config: requestConfig,
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
        streamCancelled = true;
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

  // Lists available models for the given provider, annotated with the active model.
  app.get("/api/agent/providers/:provider/models", async (c) => {
    const provider = c.req.param("provider");
    const profile = runtime.config.agent.providerProfiles[provider];
    try {
      const models = await DEFAULT_AGENT_MODEL_REGISTRY.listAvailableModels(runtime.config.agent, provider);
      return c.json({
        provider,
        apiMode: apiModeForProvider(provider),
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
