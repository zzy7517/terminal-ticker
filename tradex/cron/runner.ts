/**
 * Single cron job execution logic.
 *
 * Creates a SessionManager for the run, assembles tools from the live runtime,
 * invokes the agent loop, and persists the result as a cron session JSONL file.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { CronJobConfig, AgentConfig } from "../config/index.js";
import { normalizeApiMode } from "../config/agent_models.js";
import { AgentRuntime } from "../agent/runtime.js";
import { SessionManager } from "../agent/session_manager.js";
import { buildMarketTools } from "../agent/tools/market.js";
import { buildNewsTools } from "../agent/tools/news.js";
import { buildMemoryTools } from "../memory/tools.js";
import { buildWebTools } from "../agent/tools/web.js";
import { buildTradingTools } from "../agent/tools/trading.js";
import { buildSocialFeedTools } from "../agent/tools/social.js";
import { mergeRegistries, type ToolRegistry } from "../agent/tools/registry.js";
import { newCronSessionPath } from "./store.js";
import type { AppRuntime } from "../api/runtime.js";

export interface CronRunResult {
  sessionId: string;
  filePath: string;
  content: string;
  iterations: number;
  totalTokens: number;
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
  const sessionId = crypto.randomUUID();
  const filePath = newCronSessionPath(job.name, sessionId);

  // Write the session JSONL directly to the cron-specific path.
  // We cannot use SessionManager.create() because it forces the file into
  // agent_sessions/. Instead, we write the header manually and then open it.
  const provider = resolveProvider(job, runtime);
  const model = resolveModel(job, runtime);
  const header = {
    type: "session",
    version: 1,
    id: sessionId,
    timestamp: new Date().toISOString(),
    title: `[cron] ${job.name}`,
    provider,
    model,
  };
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(header) + "\n");

  const cronMgr = SessionManager.open(filePath);

  // Append the user message
  cronMgr.appendMessage({ role: "user", content: job.userMessage });

  // Build agent config, optionally overriding model from job config
  const agentConfig = buildAgentConfigForJob(job, runtime.config.agent);
  const agentRuntime = new AgentRuntime({ config: agentConfig });

  const maxCandles = job.maxCandles ?? runtime.config.agent.maxCandles;

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
    buildMemoryTools(runtime.config.memory.storagePath),
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

  if (job.socialEnabled) {
    registries.push(
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
    );
  }

  const tools = mergeRegistries(...registries);

  let content = "";
  let error: string | null = null;
  let iterations = 0;
  let totalTokens = 0;

  try {
    const result = await agentRuntime.run({
      message: job.userMessage,
      tools,
      history: [],
      systemPrompt: job.systemPrompt || null,
      eventHandler: null,
      maxIterations: job.maxIterations ?? undefined,
    });

    content = result.content || "";
    iterations = result.iterations;
    totalTokens = result.totalTokens;
    error = result.error;

    // Persist assistant response
    cronMgr.appendMessage({
      role: "assistant",
      content,
      metadata: {
        iterations,
        totalTokens,
        promptTokens: result.promptTokens,
        finished: result.finished,
      },
    });
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught);
    cronMgr.appendMessage({
      role: "assistant",
      content: `[cron job error] ${error}`,
      error,
    });
  }

  // Write completion marker so the store can distinguish ok/error/running
  const durationMs = Date.now() - startMs;
  cronMgr.appendCustomEntry("cron_run_complete", {
    status: error ? "error" : "ok",
    error,
    durationMs,
    iterations,
    totalTokens,
  });

  return {
    sessionId: cronMgr.getSessionId(),
    filePath,
    content,
    iterations,
    totalTokens,
    error,
    durationMs,
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function resolveProvider(job: CronJobConfig, runtime: AppRuntime): string {
  if (job.model) {
    // "codex:gpt-5.4" → provider "codex", "anthropic:claude-..." → provider "anthropic"
    const colonIdx = job.model.indexOf(":");
    if (colonIdx > 0) return job.model.slice(0, colonIdx);
  }
  return runtime.config.agent.provider;
}

function resolveModel(job: CronJobConfig, runtime: AppRuntime): string {
  if (job.model) {
    const colonIdx = job.model.indexOf(":");
    if (colonIdx > 0) return job.model.slice(colonIdx + 1);
    return job.model;
  }
  return runtime.config.agent.model;
}

function buildAgentConfigForJob(job: CronJobConfig, baseConfig: AgentConfig): AgentConfig {
  const provider = job.model ? resolveProviderFromModel(job.model, baseConfig.provider) : baseConfig.provider;
  const model = job.model ? resolveModelFromModel(job.model, baseConfig.model) : baseConfig.model;

  return {
    ...baseConfig,
    provider,
    apiMode: normalizeApiMode(provider),
    model,
    providerProfiles: {
      ...baseConfig.providerProfiles,
      [provider]: {
        ...(baseConfig.providerProfiles[provider] ?? {
          enabled: true,
          models: [],
          modelEfforts: [],
          apiKey: "",
          baseUrl: "",
          customModels: [],
        }),
        enabled: true,
        models: [model],
      },
    },
  };
}

function resolveProviderFromModel(modelSpec: string, fallback: string): string {
  const colonIdx = modelSpec.indexOf(":");
  return colonIdx > 0 ? modelSpec.slice(0, colonIdx) : fallback;
}

function resolveModelFromModel(modelSpec: string, fallback: string): string {
  const colonIdx = modelSpec.indexOf(":");
  return colonIdx > 0 ? modelSpec.slice(colonIdx + 1) : modelSpec || fallback;
}
