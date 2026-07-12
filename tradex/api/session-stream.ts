import crypto from "node:crypto";
import type { ActiveRuntimeRun, RuntimeEvent, RuntimeRunResult } from "../agent/runtime/types.js";
import { AgentSseWriter } from "./agent_sse.js";
import type { AppRuntime } from "./runtime.js";

export type SessionStreamSend = (event: Record<string, unknown>) => void;

export interface SessionRunBinding {
  run: ActiveRuntimeRun;
  onEvent(event: RuntimeEvent, send: SessionStreamSend): void | Promise<void>;
  complete(result: RuntimeRunResult, send: SessionStreamSend): void | Promise<void>;
  fail(error: unknown, send: SessionStreamSend): void | Promise<void>;
  cleanup?(): void | Promise<void>;
}

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
    cancel() {
      cancelled = true;
      sse.cancel();
      activeRun?.abort();
    },
  });
  return new Response(stream, { headers: { "Content-Type": "text/event-stream" } });
}
