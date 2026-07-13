/**
 * Single cron job execution logic.
 *
 * Creates a SessionManager for the run, assembles tools from the live runtime,
 * invokes the agent loop, and persists the result as a cron session JSONL file.
 */

import type { CronJobConfig } from "../config/index.js";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { PiSdkRuntime } from "../agent/runtime/pi/runtime.js";
import { agentConfigForModelSelection } from "../agent/runtime/pi/models/runtime.js";
import { createPiSession, piProviderName } from "../agent/runtime/pi/sessions.js";
import { buildMarketTools } from "../agent/tools/market.js";
import { buildNewsTools } from "../agent/tools/news.js";
import { buildWebTools } from "../agent/tools/web.js";
import { buildTradingTools } from "../agent/tools/trading.js";
import { buildOptionsTools } from "../agent/tools/options.js";
import { buildBrowserTools } from "../agent/tools/browser.js";
import { mergeRegistries, type ToolRegistry } from "../agent/tools/registry.js";
import { buildMcpToolRegistry } from "../mcp/index.js";
import { MAIN_AGENT_PROMPT } from "../agent/prompts.js";
import { jobDir } from "./store.js";
import type { AppRuntime } from "../api/runtime.js";

const DEFAULT_CRON_MAX_ITERATIONS = 10;

export interface CronRunResult {
  sessionId: string;
  filePath: string;
  content: string;
  iterations: number;
  error: string | null;
  durationMs: number;
}

/**
 * Executes a single cron job run end-to-end:
 * 1. Creates a session JSONL file in the job's cron_sessions subdirectory.
 * 2. Assembles the tool registry from the live runtime (market quotes, news, memory).
 * 3. Runs the agent loop with the job's system prompt and user message.
 * 4. Writes the completion marker so the store can distinguish ok/error/running.
 */
export async function executeCronJob(input: {
  job: CronJobConfig;
  runtime: AppRuntime;
}): Promise<CronRunResult> {
  const { job, runtime } = input;
  const startMs = Date.now();
  const agentConfig = agentConfigForModelSelection(runtime.config.agent, job.model);
  const modelRuntime = runtime.modelRuntimeSnapshot;
  const cronMgr = createPiSession({
    title: `[cron] ${job.name}`,
    sessionDir: jobDir(job.name),
  });
  cronMgr.appendModelChange(piProviderName(agentConfig.provider), agentConfig.model);
  const sessionId = cronMgr.getSessionId();
  const filePath = cronMgr.getSessionFile();
  if (!filePath) throw new Error("Pi did not create a persistent cron session");

  const maxCandles = job.maxCandles ?? runtime.config.agent.maxCandles;
  const memoryRegistry = await runtime.memoryPort.buildTools();

  // Assemble tools — always include market + news + memory + web
  const registries: ToolRegistry[] = [
    buildMarketTools({ quotes: runtime.controller.quotes, maxCandles, candleContextMode: agentConfig.candleContextMode }),
    buildNewsTools({
      recent: (limit, sinceMinutes) =>
        runtime.newsService.recent(limit ?? undefined).filter((item) => {
          if (sinceMinutes == null) return true;
          return item.publishedAtMs >= Date.now() - sinceMinutes * 60_000;
        }),
      refresh: () => runtime.newsService.refreshNow(),
    }),
    ...(memoryRegistry ? [memoryRegistry] : []),
    buildWebTools(),
  ];

  if (job.tradingEnabled) {
    registries.push(
      buildTradingTools({
        tradeStore: runtime.tradeStore,
        exchangeRouter: runtime.exchangeRouter,
        tradingConfig: runtime.config.trading,
        resolveSessionId: () => sessionId,
        captureSnapshot: null,
      }),
    );
  }

  // Add browser tools if enabled
  if (runtime.config.browser.enabled) {
    registries.push(buildBrowserTools(runtime.browserManager));
  }

  // Add options/GEX tools if enabled
  if (runtime.optionsService) {
    registries.push(buildOptionsTools(runtime));
  }

  // Add MCP tools if available
  if (runtime.mcpManager) {
    registries.push(await buildMcpToolRegistry(runtime.mcpManager, runtime.mcpManager.getConfig()));
  }

  const tools = mergeRegistries(...registries);

  let content = "";
  let error: string | null = null;
  let iterations = 0;

  try {
    // Build system prompt: optionally prepend MAIN_AGENT_PROMPT + job-specific prompt.
    let systemPrompt = "";
    if (job.useMainPrompt) {
      systemPrompt = MAIN_AGENT_PROMPT;
      if (job.systemPrompt) {
        systemPrompt += "\n\n" + job.systemPrompt;
      }
    } else {
      systemPrompt = job.systemPrompt || "";
    }
    const memoryContext = await runtime.memoryPort.getPromptContext();
    if (memoryContext) {
      systemPrompt = systemPrompt ? `${systemPrompt}\n${memoryContext}` : memoryContext;
    }
    const maxIterations = job.maxIterations ?? DEFAULT_CRON_MAX_ITERATIONS;

    const agent = await new PiSdkRuntime().start({
      config: agentConfig,
      modelRuntime,
      systemPrompt,
      tools,
      maxTurns: maxIterations,
      sessionManager: cronMgr,
      prompt: job.userMessage,
    });

    agent.subscribe((event) => {
      if (event.type === "turn-end") {
        iterations += 1;
        const message = event.message;
        if (message.error) {
          error = message.error;
        }
        // Capture text content from this assistant turn. The final turn's
        // text is what we surface as the cron run output.
        const text = message.content
          .filter((c): c is Extract<typeof c, { type: "text" }> => c.type === "text")
          .map((c) => c.text)
          .join("");
        if (text) content = text;
      }
    });

    const result = await agent.result;
    if (result.error) error = result.error;

  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught);
    cronMgr.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: `[cron job error] ${error}` }],
      provider: piProviderName(agentConfig.provider),
      model: agentConfig.model,
      api: agentConfig.apiMode,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "error",
      errorMessage: error,
      timestamp: Date.now(),
    } as AssistantMessage);
  }

  // Write completion marker so the store can distinguish ok/error/running
  const durationMs = Date.now() - startMs;
  cronMgr.appendCustomEntry("cron_run_complete", {
    status: error ? "error" : "ok",
    error,
    durationMs,
    iterations,
  });

  return {
    sessionId: cronMgr.getSessionId(),
    filePath,
    content,
    iterations,
    error,
    durationMs,
  };
}
