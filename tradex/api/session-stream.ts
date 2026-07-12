// 为所有 Agent Runtime 提供统一的 Session SSE 生命周期编排。
import crypto from "node:crypto";
import type { ActiveRuntimeRun, RuntimeEvent, RuntimeRunResult } from "../agent/runtime/types.js";
import { AgentSseWriter } from "./agent_sse.js";
import type { AppRuntime } from "./runtime.js";

export type SessionStreamSend = (event: Record<string, unknown>) => void;

export interface SessionRunBinding {
  run: ActiveRuntimeRun;
  // 消费并投影单个统一 Runtime 事件。
  onEvent(event: RuntimeEvent, send: SessionStreamSend): void | Promise<void>;
  // 在 Runtime 正常结算后发送最终状态。
  complete(result: RuntimeRunResult, send: SessionStreamSend): void | Promise<void>;
  // 在运行或持久化失败后发送错误状态。
  fail(error: unknown, send: SessionStreamSend): void | Promise<void>;
  // 释放 Runtime 绑定持有的临时资源。
  cleanup?(): void | Promise<void>;
}

// 锁定 Session、运行 Runtime 并保证结算后释放所有活动状态。
export function streamSessionRun(input: {
  runtime: AppRuntime;
  sessionId: string;
  prepare(): Promise<SessionRunBinding>;
}): Response {
  const { runtime, sessionId } = input;
  if (runtime.lockedAgentSessions.has(sessionId)) {
    return Response.json({ detail: "an agent run is already active for this session" }, { status: 409 });
  }
  runtime.lockedAgentSessions.add(sessionId);
  const runId = crypto.randomUUID();
  const sse = new AgentSseWriter(sessionId, runId);
  let activeRun: ActiveRuntimeRun | null = null;
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    // 启动 Runtime 并将有序事件持续写入 SSE 响应。
    async start(controller) {
      const send: SessionStreamSend = (event) => sse.send(controller, event);
      let binding: SessionRunBinding | null = null;
      send({ type: "agent_start" });
      try {
        binding = await input.prepare();
        activeRun = binding.run;
        if (cancelled) {
          await binding.run.abort();
          await binding.run.result;
          return;
        }
        runtime.activeAgents.set(sessionId, binding.run);
        const unsubscribe = binding.run.subscribe((event) => binding?.onEvent(event, send));
        const result = await binding.run.result;
        unsubscribe();
        if (result.errorCode === "runtime_listener_failed") throw new Error(result.error ?? "runtime listener failed");
        await binding.complete(result, send);
      } catch (error) {
        if (binding) await binding.fail(error, send);
        else {
          const detail = error instanceof Error ? error.message : String(error);
          send({ type: "error", code: "runtime_failure", error: detail });
          send({ type: "agent_end", error: detail, totalTokens: 0, promptTokens: 0, sessionStats: null });
        }
      } finally {
        try {
          await binding?.cleanup?.();
        } finally {
          runtime.activeAgents.delete(sessionId);
          runtime.lockedAgentSessions.delete(sessionId);
          try { controller.close(); } catch { /* stream already cancelled */ }
        }
      }
    },
    // 在客户端断开时取消 SSE 并中止活动 Runtime。
    cancel() {
      cancelled = true;
      sse.cancel();
      activeRun?.abort();
    },
  });
  return new Response(stream, { headers: { "Content-Type": "text/event-stream" } });
}
