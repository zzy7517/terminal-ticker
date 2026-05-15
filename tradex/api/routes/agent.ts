import { Hono } from "hono";
import crypto from "node:crypto";
import { resolveAgentModelFromConfig } from "../../agent/models.js";
import { SessionManager } from "../../agent/session_manager.js";
import { DEFAULT_AGENT_MODEL_REGISTRY } from "../../agent/model_registry.js";
import { buildMarketTools } from "../../agent/tools/market.js";
import { buildMemoryTools } from "../../memory/tools.js";
import { buildNewsTools } from "../../agent/tools/news.js";
import { buildSocialFeedTools } from "../../agent/tools/social.js";
import { buildTradingTools } from "../../agent/tools/trading.js";
import { buildWebTools } from "../../agent/tools/web.js";
import { mergeRegistries } from "../../agent/tools/registry.js";
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
    const assistantClientId = `assistant:${crypto.randomUUID()}`;
    const toolCallsById = new Map<string, Record<string, unknown>>();
    let seq = 0;

    const sendFrame = (controller: ReadableStreamDefaultController<Uint8Array>, event: Record<string, unknown>) => {
      seq += 1;
      controller.enqueue(encoder.encode(`data: ${JSON.stringify({ sessionId, runId, seq, event })}\n\n`));
    };

    const stream = new ReadableStream({
      async start(controller) {
        sendFrame(controller, { type: "agent_start" });
        let assistantEntryId: string | null = null;

        try {
          // ---- Session bookkeeping ----
          const conversationHistory = mgr.historyForContext({ limit: 12 });
          mgr.appendMessage({ role: "user", content: message });
          assistantEntryId = mgr.appendMessage({
            role: "assistant",
            content: "",
            metadata: { toolCalls: [] },
            error: null,
          });
          runtime.pendingSessionManagers.delete(sessionId);
          const currentAssistantEntryId = assistantEntryId;
          const assistantEntry = mgr.getEntry(currentAssistantEntryId);

          sendFrame(controller, {
            type: "message_start",
            message: {
              id: currentAssistantEntryId,
              clientId: assistantClientId,
              sessionId,
              role: "assistant",
              content: "",
              createdAt: assistantEntry?.timestamp ?? new Date().toISOString(),
              metadata: { toolCalls: [] },
              error: null,
              entryId: currentAssistantEntryId,
              parentId: assistantEntry?.parentId ?? null,
              entryType: "message",
            },
          });

          // ---- Build tools (same as before) ----
          const requestConfig = agentConfigForRequest(runtime.config.agent, body);
          const tools = mergeRegistries(
            buildMarketTools({ quotes: runtime.controller.quotes, maxCandles: runtime.config.agent.maxCandles }),
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
          );

          // ---- Create Agent (new core) ----
          const resolved = resolveAgentModelFromConfig(requestConfig);
          const modelDescriptor: AgentModelDescriptor = {
            id: resolved.id,
            provider: resolved.provider,
            api: resolved.api,
            baseUrl: resolved.baseUrl,
            reasoningEffort: resolved.reasoningEffort,
            accountId: resolved.accountId,
          };

          const agent = new Agent({
            initialState: {
              systemPrompt: "",
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
            onDelta: (delta: string) => {
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
            },
          });

          // Restore conversation history into agent
          for (const msg of conversationHistory) {
            const role = String(msg.role || "");
            if (role === "user") {
              agent.messages = [...agent.messages, { role: "user", content: String(msg.content || ""), timestamp: Date.now() }];
            } else if (role === "assistant") {
              agent.messages = [...agent.messages, {
                role: "assistant",
                content: [{ type: "text" as const, text: String(msg.content || "") }],
                provider: modelDescriptor.provider,
                model: modelDescriptor.id,
                usage: { input: 0, output: 0, totalTokens: 0 },
                stopReason: "stop" as const,
                timestamp: Date.now(),
              }];
            } else if (role === "system") {
              agent.messages = [...agent.messages, { role: "user", content: String(msg.content || ""), timestamp: Date.now() }];
            } else if (role === "tool") {
              agent.messages = [...agent.messages, {
                role: "toolResult" as const,
                toolCallId: String(msg.tool_call_id || ""),
                toolName: String(msg.name || ""),
                content: [{ type: "text" as const, text: String(msg.content || "") }],
                isError: false,
                timestamp: Date.now(),
              }];
            }
          }

          // ---- Subscribe to agent events ----
          let finalContent = "";
          let finalError: string | null = null;
          let totalTokens = 0;
          let promptTokens = 0;

          agent.subscribe((event) => {
            switch (event.type) {
              case "tool_execution_start": {
                const toolCall = { id: event.toolCallId, name: event.toolName, arguments: event.args };
                toolCallsById.set(event.toolCallId, toolCall);
                mgr.updateMessage(currentAssistantEntryId, {
                  metadata: { toolCalls: Array.from(toolCallsById.values()) },
                });
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
                // Persist tool result to session
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
                if (msg.role === "assistant") {
                  const assistant = msg as AssistantMessage;
                  finalContent = assistant.content
                    .filter((c): c is TextContent => c.type === "text")
                    .map((c) => c.text)
                    .join("");
                  finalError = assistant.errorMessage ?? null;
                  totalTokens += assistant.usage.totalTokens;
                  promptTokens += assistant.usage.input;
                }
                break;
              }

              default:
                break;
            }
          });

          // ---- Run the agent ----
          await agent.prompt(message);

          // ---- Finalize session ----
          const metadata = {
            totalTokens,
            promptTokens,
            toolCalls: Array.from(toolCallsById.values()),
          };
          const finalizedAssistantEntry = mgr.updateMessage(currentAssistantEntryId, {
            content: finalContent,
            metadata,
            error: finalError,
          });

          sendFrame(controller, {
            type: "message_end",
            message: {
              id: currentAssistantEntryId,
              clientId: assistantClientId,
              sessionId,
              role: "assistant",
              content: finalContent,
              createdAt: finalizedAssistantEntry.timestamp,
              metadata,
              error: finalError,
              entryId: currentAssistantEntryId,
              parentId: finalizedAssistantEntry.parentId ?? null,
              entryType: "message",
            },
          });

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
          if (assistantEntryId) {
            try {
              mgr.updateMessage(assistantEntryId, { content: errorText, error: errorText });
            } catch {
              // Best-effort persistence for failed runs.
            }
          }
          sendFrame(controller, { type: "error", error: errorText });
          sendFrame(controller, { type: "agent_end", error: errorText, totalTokens: 0, promptTokens: 0 });
        } finally {
          controller.close();
        }
      },
    });

    return new Response(stream, { headers: { "Content-Type": "text/event-stream" } });
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
    });
    return c.json({ state: await reloadAndState(runtime, watchlistPath) });
  });

  return app;
}
