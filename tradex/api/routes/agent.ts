import { Hono } from "hono";
import crypto from "node:crypto";
import { resolveAgentModelFromConfig } from "../../agent/models.js";
import { SessionManager } from "../../agent/session_manager.js";
import { DEFAULT_AGENT_MODEL_REGISTRY } from "../../agent/model_registry.js";
import { buildMarketTools } from "../../agent/tools/market.js";
import { buildMemoryTools } from "../../memory/tools.js";
import { buildMemoryDeveloperInstructions } from "../../memory/read/index.js";
import { buildNewsTools } from "../../agent/tools/news.js";
import { buildSocialFeedTools } from "../../agent/tools/social.js";
import { buildTradingTools } from "../../agent/tools/trading.js";
import { buildWebTools } from "../../agent/tools/web.js";
import { createFilesystemRegistry, setFilesystemRoot } from "../../agent/tools/filesystem.js";
import { mergeRegistries, ToolRegistry } from "../../agent/tools/registry.js";
import { buildMcpToolRegistry } from "../../mcp/index.js";
import { updateAgentConfigInWatchlist } from "../../config/watchlist_store.js";
import { Agent, registryToAgentTools, createStreamFnFromRegistry } from "../../agent/core/index.js";
import type { AssistantMessage, TextContent, AgentModelDescriptor } from "../../agent/core/types.js";
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
  app.get("/api/agent/sessions", (c) => c.json(sessionHistory(runtime)));

  // Creates a new agent session and returns it alongside the updated history.
  app.post("/api/agent/sessions", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const mgr = SessionManager.create({
      title: String(body.title || "New Agent Session"),
      provider: String(body.provider || runtime.config.agent.provider),
      model: String(body.model || runtime.config.agent.model),
      index: runtime.sessionIndex,
    });
    runtime.pendingSessionManagers.set(mgr.getSessionId(), mgr);
    const payload = mgr.sessionPayload();
    const sessionResp = { ...payload, run: idleRun(mgr.getSessionId()) };
    return c.json({
      ...sessionResp,
      history: sessionHistory(runtime),
    });
  });

  // Returns the full message history for a single agent session.
  app.get("/api/agent/sessions/:id", (c) => {
    return c.json(sessionResponse(runtime, c.req.param("id")));
  });

  // Deletes a session from disk and evicts it from the pending map.
  app.delete("/api/agent/sessions/:id", async (c) => {
    const sessionId = c.req.param("id");
    runtime.pendingSessionManagers.delete(sessionId);
    SessionManager.deleteSession(sessionId, runtime.sessionIndex);
    return c.json({ session: { session: null, messages: [] }, history: sessionHistory(runtime), state: await runtime.state() });
  });

  // Streams an agent run as SSE using the new stateful Agent from core/.
  app.post("/api/agent/sessions/:id/messages/stream", async (c) => {
    const sessionId = c.req.param("id");
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const message = String(body.message || "").trim();
    if (!message) {
      return c.json({ detail: "message is required" }, 400);
    }
    const mgr = openSessionManager(sessionId, runtime);
    if (!mgr) {
      return c.json({ detail: "agent session not found" }, 404);
    }

    const encoder = new TextEncoder();
    const runId = crypto.randomUUID();
    let assistantClientId = "";
    const toolCallsById = new Map<string, Record<string, unknown>>();
    let seq = 0;

    const sendFrame = (controller: ReadableStreamDefaultController<Uint8Array>, event: Record<string, unknown>) => {
      seq += 1;
      controller.enqueue(encoder.encode(`data: ${JSON.stringify({ sessionId, runId, seq, event })}\n\n`));
    };

    const stream = new ReadableStream({
      async start(controller) {
        sendFrame(controller, { type: "agent_start" });

        try {
          // ---- Session bookkeeping ----
          const conversationHistory = mgr.buildSessionContext();
          mgr.appendMessage({ role: "user", content: message });
          runtime.pendingSessionManagers.delete(sessionId);

          // ---- Build tools ----
          const requestConfig = agentConfigForRequest(runtime.config.agent, body);
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
            buildMemoryTools(runtime.config.memory.storagePath),
            buildTradingTools({
              tradeStore: runtime.tradeStore,
              exchangeRouter: runtime.exchangeRouter,
              resolveSessionId: () => sessionId,
            }),
            buildWebTools(),
            createFilesystemRegistry(),
            ...(runtime.mcpManager ? [buildMcpToolRegistry(runtime.mcpManager, { mcpServers: runtime.mcpManager.getServerConfig(), settings: undefined })] : []),
          );

          // ---- Create Agent ----
          const resolved = resolveAgentModelFromConfig(requestConfig);
          const modelDescriptor: AgentModelDescriptor = {
            id: resolved.id,
            provider: resolved.provider,
            api: resolved.api,
            baseUrl: resolved.baseUrl,
            reasoningEffort: resolved.reasoningEffort,
            accountId: resolved.accountId,
          };

          // Inject memory context into system prompt when available.
          const memoryInstructions = runtime.config.memory.enabled && runtime.config.memory.useMemories
            ? buildMemoryDeveloperInstructions(runtime.config.memory.storagePath)
            : null;
          const systemPrompt = memoryInstructions ?? "";

          const agent = new Agent({
            initialState: {
              systemPrompt,
              model: modelDescriptor,
              thinkingLevel: "off",
              tools: registryToAgentTools(tools),
              messages: [],
            },
            streamFn: createStreamFnFromRegistry(),
            apiKey: resolved.apiKey,
            getApiKey: async () => {
              const fresh = resolveAgentModelFromConfig(requestConfig);
              return fresh.apiKey;
            },
            toolExecution: "sequential",
          });

          // Restore conversation history into agent.
          // Track tool call IDs from assistant messages so we can drop orphaned
          // toolResult entries whose parent assistant was skipped (e.g. empty/error turns).
          const restoredToolCallIds = new Set<string>();
          for (const msg of conversationHistory) {
            const role = String(msg.role || "");
            const meta = (msg.metadata ?? {}) as Record<string, unknown>;
            if (role === "user") {
              agent.messages = [...agent.messages, { role: "user", content: String(msg.content || ""), timestamp: Date.now() }];
            } else if (role === "assistant") {
              const assistantContent: Array<{ type: "text"; text: string } | { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown> }> = [];
              const text = String(msg.content || "");
              if (text) {
                assistantContent.push({ type: "text" as const, text });
              }
              const toolCalls = Array.isArray(meta.toolCalls) ? meta.toolCalls : [];
              for (const tc of toolCalls) {
                const tcObj = tc as Record<string, unknown>;
                const tcId = String(tcObj.id || "");
                assistantContent.push({
                  type: "toolCall" as const,
                  id: tcId,
                  name: String(tcObj.name || ""),
                  arguments: (typeof tcObj.arguments === "object" && tcObj.arguments !== null ? tcObj.arguments : {}) as Record<string, unknown>,
                });
                restoredToolCallIds.add(tcId);
              }
              if (assistantContent.length === 0) continue;
              agent.messages = [...agent.messages, {
                role: "assistant",
                content: assistantContent,
                provider: modelDescriptor.provider,
                model: modelDescriptor.id,
                usage: { input: 0, output: 0, totalTokens: 0 },
                stopReason: "stop" as const,
                timestamp: Date.now(),
              }];
            } else if (role === "system") {
              agent.messages = [...agent.messages, { role: "user", content: String(msg.content || ""), timestamp: Date.now() }];
            } else if (role === "toolResult") {
              const toolCallId = String(meta.toolCallId || "");
              if (!toolCallId || !restoredToolCallIds.has(toolCallId)) continue;
              agent.messages = [...agent.messages, {
                role: "toolResult" as const,
                toolCallId,
                toolName: String(meta.toolName || ""),
                content: [{ type: "text" as const, text: String(msg.content || "") }],
                isError: Boolean(meta.error),
                timestamp: Date.now(),
              }];
            }
          }

          // ---- Subscribe to agent events ----
          let finalError: string | null = null;
          let totalTokens = 0;
          let promptTokens = 0;
          let currentAssistantTurnEntryId: string | null = null;
          let initialUserMessageSeen = false;

          agent.subscribe((event) => {
            switch (event.type) {
              case "message_start": {
                const msg = event.message;
                if (msg.role === "user") {
                  if (!initialUserMessageSeen) {
                    initialUserMessageSeen = true;
                    break;
                  }
                  const userContent = typeof msg.content === "string"
                    ? msg.content
                    : (msg.content as Array<{ type: string; text?: string }>)
                        .filter((c) => c.type === "text")
                        .map((c) => c.text ?? "")
                        .join("");
                  const userEntryId = mgr.appendMessage({ role: "user", content: userContent });
                  const userEntry = mgr.getEntry(userEntryId);
                  sendFrame(controller, {
                    type: "message_end",
                    message: {
                      id: userEntryId,
                      sessionId,
                      role: "user",
                      content: userContent,
                      createdAt: userEntry?.timestamp ?? new Date().toISOString(),
                      metadata: null,
                      error: null,
                      entryId: userEntryId,
                      parentId: userEntry?.parentId ?? null,
                      entryType: "message",
                    },
                  });
                } else if (msg.role === "assistant") {
                  // Every assistant message_start creates a fresh turn
                  toolCallsById.clear();
                  assistantClientId = `assistant:${crypto.randomUUID()}`;
                  const entryId = mgr.appendMessage({
                    role: "assistant",
                    content: "",
                    metadata: { toolCalls: [] },
                    error: null,
                  });
                  currentAssistantTurnEntryId = entryId;
                  const entry = mgr.getEntry(entryId);
                  sendFrame(controller, {
                    type: "message_start",
                    message: {
                      id: entryId,
                      clientId: assistantClientId,
                      sessionId,
                      role: "assistant",
                      content: "",
                      createdAt: entry?.timestamp ?? new Date().toISOString(),
                      metadata: { toolCalls: [] },
                      error: null,
                      entryId,
                      parentId: entry?.parentId ?? null,
                      entryType: "message",
                    },
                  });
                }
                break;
              }

              case "message_update": {
                if (event.message.role === "assistant") {
                  const delta = event.delta ?? "";
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
                break;
              }

              case "tool_execution_start": {
                const toolCall = { id: event.toolCallId, name: event.toolName, arguments: event.args };
                toolCallsById.set(event.toolCallId, toolCall);
                if (currentAssistantTurnEntryId) {
                  mgr.updateMessage(currentAssistantTurnEntryId, {
                    metadata: { toolCalls: Array.from(toolCallsById.values()) },
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
                sendFrame(controller, {
                  type: "tool_execution_end",
                  toolCall: toolCallsById.get(event.toolCallId) ?? { id: event.toolCallId, name: event.toolName, arguments: {} },
                  toolResult: { callId: event.toolCallId, name: event.toolName, output: toolOutput.slice(0, 2000), error: event.isError },
                });
                const entryId = mgr.appendMessage({
                  role: "toolResult",
                  content: toolOutput,
                  metadata: { toolCallId: event.toolCallId, toolName: event.toolName, error: event.isError },
                  error: event.isError ? toolOutput : null,
                });
                const toolEntry = mgr.getEntry(entryId);
                sendFrame(controller, {
                  type: "message_end",
                  message: {
                    id: entryId,
                    sessionId,
                    role: "toolResult",
                    content: toolOutput,
                    createdAt: toolEntry?.timestamp ?? new Date().toISOString(),
                    metadata: { toolCallId: event.toolCallId, toolName: event.toolName, error: event.isError },
                    error: event.isError ? toolOutput : null,
                    entryId,
                    parentId: toolEntry?.parentId ?? null,
                    entryType: "message",
                  },
                });
                break;
              }

              case "message_end": {
                const msg = event.message;
                if (msg.role === "assistant" && currentAssistantTurnEntryId) {
                  const assistant = msg as AssistantMessage;
                  const turnContent = assistant.content
                    .filter((c): c is TextContent => c.type === "text")
                    .map((c) => c.text)
                    .join("");
                  finalError = assistant.errorMessage ?? null;
                  totalTokens += assistant.usage.totalTokens;
                  promptTokens += assistant.usage.input;
                  // Extract tool calls declared in the assistant message content
                  for (const c of assistant.content) {
                    if (c.type === "toolCall") {
                      toolCallsById.set(c.id, { id: c.id, name: c.name, arguments: c.arguments });
                    }
                  }
                  const turnMetadata = {
                    totalTokens: assistant.usage.totalTokens,
                    promptTokens: assistant.usage.input,
                    toolCalls: Array.from(toolCallsById.values()),
                  };
                  const updated = mgr.updateMessage(currentAssistantTurnEntryId, {
                    content: turnContent,
                    metadata: turnMetadata,
                    error: finalError,
                  });
                  sendFrame(controller, {
                    type: "message_end",
                    message: {
                      id: currentAssistantTurnEntryId,
                      clientId: assistantClientId,
                      sessionId,
                      role: "assistant",
                      content: turnContent,
                      createdAt: updated.timestamp,
                      metadata: turnMetadata,
                      error: finalError,
                      entryId: currentAssistantTurnEntryId,
                      parentId: updated.parentId ?? null,
                      entryType: "message",
                    },
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
          await agent.prompt(message);

          sendFrame(controller, {
            type: "agent_end",
            error: finalError,
            totalTokens,
            promptTokens,
          });

          sendFrame(controller, {
            type: "session_update",
            session: sessionResponse(runtime, sessionId),
            history: sessionHistory(runtime),
            state: await runtime.state(),
          });

        } catch (error) {
          const errorText = error instanceof Error ? error.message : String(error);
          sendFrame(controller, { type: "error", error: errorText });
          sendFrame(controller, { type: "agent_end", error: errorText, totalTokens: 0, promptTokens: 0 });
        } finally {
          runtime.activeAgents.delete(sessionId);
          controller.close();
        }
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
