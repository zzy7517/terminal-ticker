// 为所有 Agent Runtime 提供统一的 Session SSE 生命周期编排。
import crypto from "node:crypto";
import type { ActiveRuntimeRun, RuntimeEvent, RuntimeRunResult } from "../agent/runtime/types.js";
import { AgentSseWriter } from "./agent-sse.js";
import type { AppRuntime } from "./runtime.js";

export type SessionStreamSend = (event: Record<string, unknown>) => void;

/** Carries a terminal Runtime result code through the binding failure path. */
export class SessionRunError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "SessionRunError";
  }
}

declare const sessionRunReservationBrand: unique symbol;

/** Opaque proof that this module reserved one Session before async preflight. */
export interface SessionRunReservation {
  readonly sessionId: string;
  readonly [sessionRunReservationBrand]: true;
}

interface SessionRunReservationState {
  runtime: AppRuntime;
  sessionId: string;
  phase: "reserved" | "streaming" | "released";
  cancelRequested: boolean;
  activeRun: ActiveRuntimeRun | null;
  abortController: AbortController;
}

const reservationStates = new WeakMap<SessionRunReservation, SessionRunReservationState>();
const reservationsByRuntime = new WeakMap<AppRuntime, Map<string, SessionRunReservation>>();

export interface SessionUpdateProjection<Session, History> {
  session: Session;
  history: History;
}

export type ProjectSessionUpdate<Session, History> = () => Promise<SessionUpdateProjection<Session, History>>;

/** Send the final projection without leaking Agent-only market state into Origin events. */
export async function sendSessionUpdate<Session, History, DefaultSession, DefaultHistory, State>(input: {
  send: SessionStreamSend;
  project?: ProjectSessionUpdate<Session, History>;
  defaultProject: ProjectSessionUpdate<DefaultSession, DefaultHistory>;
  state: () => Promise<State>;
}): Promise<void> {
  const projection = input.project ? await input.project() : await input.defaultProject();
  input.send({
    type: "session_update",
    session: projection.session,
    history: projection.history,
    ...(input.project ? {} : { state: await input.state() }),
  });
}

export interface SessionRunBinding {
  run: ActiveRuntimeRun;
  // 消费并投影单个统一 Runtime 事件。
  onEvent(event: RuntimeEvent, send: SessionStreamSend): void | Promise<void>;
  // 在 Runtime 正常结算后发送最终状态。
  complete(result: RuntimeRunResult, send: SessionStreamSend): void | Promise<void>;
  // 在运行或持久化失败后发送错误状态。
  fail(error: unknown, send: SessionStreamSend): void | Promise<void>;
}

/**
 * Reserve a Session across async preflight. Returning a non-stream response or
 * throwing releases it; passing the reservation to streamSessionRun transfers
 * the remaining lifecycle to the stream orchestrator.
 */
export async function withSessionRunReservation(input: {
  runtime: AppRuntime;
  sessionId: string;
  prepare(reservation: SessionRunReservation, signal: AbortSignal): Promise<Response>;
}): Promise<Response> {
  const reservation = reserveSessionRun(input.runtime, input.sessionId);
  if (reservation instanceof Response) return reservation;
  try {
    return await input.prepare(reservation, reservationStates.get(reservation)!.abortController.signal);
  } finally {
    releaseReservedSessionRun(reservation);
  }
}

/** Requests cancellation even while a reserved Session is still preparing its Runtime run. */
export async function abortSessionRun(runtime: AppRuntime, sessionId: string): Promise<boolean> {
  const reservation = reservationsByRuntime.get(runtime)?.get(sessionId);
  const state = reservation ? reservationStates.get(reservation) : null;
  if (state && state.phase !== "released") {
    state.cancelRequested = true;
    state.abortController.abort();
    await state.activeRun?.abort();
    return true;
  }
  const activeRun = runtime.activeAgents.get(sessionId);
  if (!activeRun) return false;
  await activeRun.abort();
  return true;
}

// 锁定 Session、运行 Runtime 并保证结算后释放所有活动状态。
export function streamSessionRun(input: {
  runtime: AppRuntime;
  sessionId: string;
  reservation?: SessionRunReservation;
  prepare(signal: AbortSignal): Promise<SessionRunBinding>;
  onPrepareFailure?(error: unknown, send: SessionStreamSend): void | Promise<void>;
  cleanup?(): void | Promise<void>;
}): Response {
  const { runtime, sessionId } = input;
  const reservation = input.reservation ?? reserveSessionRun(runtime, sessionId);
  if (reservation instanceof Response) return reservation;
  const reservationError = claimSessionRunReservation(reservation, runtime, sessionId);
  if (reservationError) return reservationError;
  const runId = crypto.randomUUID();
  const sse = new AgentSseWriter(sessionId, runId);
  let activeRun: ActiveRuntimeRun | null = null;
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    // 启动 Runtime 并将有序事件持续写入 SSE 响应。
    async start(controller) {
      const send: SessionStreamSend = (event) => sse.send(controller, event);
      let binding: SessionRunBinding | null = null;
      let unsubscribe: (() => void) | null = null;
      send({ type: "agent_start" });
      try {
        const reservationState = reservationStates.get(reservation);
        binding = await input.prepare(reservationState?.abortController.signal ?? AbortSignal.abort());
        activeRun = binding.run;
        if (reservationState) reservationState.activeRun = binding.run;
        if (cancelled || reservationState?.cancelRequested) {
          await binding.run.abort();
        } else {
          runtime.activeAgents.set(sessionId, binding.run);
          unsubscribe = binding.run.subscribe((event) => binding?.onEvent(event, send));
        }
        const result = await binding.run.result;
        unsubscribe?.();
        unsubscribe = null;
        if (result.errorCode === "runtime_listener_failed") {
          throw new SessionRunError(result.errorCode, result.error ?? "runtime listener failed");
        }
        await binding.complete(result, send);
      } catch (error) {
        const prepareCancelled = !binding
          && (cancelled || reservationStates.get(reservation)?.cancelRequested === true);
        if (prepareCancelled) {
          send({
            type: "agent_end",
            error: null,
            errorCode: "aborted",
            totalTokens: 0,
            promptTokens: 0,
            sessionStats: null,
          });
        } else {
          try {
            if (binding) await binding.fail(error, send);
            else if (input.onPrepareFailure) await input.onPrepareFailure(error, send);
            else throw error;
          } catch (reportingError) {
            const detail = reportingError instanceof Error ? reportingError.message : String(reportingError);
            send({ type: "error", code: "runtime_failure", error: detail });
            send({ type: "agent_end", error: detail, errorCode: "runtime_failure", totalTokens: 0, promptTokens: 0, sessionStats: null });
          }
        }
      } finally {
        try {
          try {
            unsubscribe?.();
          } finally {
            await input.cleanup?.();
          }
        } finally {
          runtime.activeAgents.delete(sessionId);
          releaseStreamingSessionRun(reservation);
          try { controller.close(); } catch { /* stream already cancelled */ }
        }
      }
    },
    // 在客户端断开时取消 SSE 并中止活动 Runtime。
    cancel() {
      cancelled = true;
      sse.cancel();
      const reservationState = reservationStates.get(reservation);
      if (reservationState) {
        reservationState.cancelRequested = true;
        reservationState.abortController.abort();
      }
      void (reservationState?.activeRun ?? activeRun)?.abort();
    },
  });
  return new Response(stream, { headers: { "Content-Type": "text/event-stream" } });
}

function reserveSessionRun(runtime: AppRuntime, sessionId: string): SessionRunReservation | Response {
  if (runtime.lockedAgentSessions.has(sessionId)) {
    return Response.json({ detail: "a Runtime run is already active for this Session" }, { status: 409 });
  }
  runtime.lockedAgentSessions.add(sessionId);
  const reservation = { sessionId } as SessionRunReservation;
  reservationStates.set(reservation, {
    runtime,
    sessionId,
    phase: "reserved",
    cancelRequested: false,
    activeRun: null,
    abortController: new AbortController(),
  });
  let reservations = reservationsByRuntime.get(runtime);
  if (!reservations) {
    reservations = new Map();
    reservationsByRuntime.set(runtime, reservations);
  }
  reservations.set(sessionId, reservation);
  return reservation;
}

function claimSessionRunReservation(
  reservation: SessionRunReservation,
  runtime: AppRuntime,
  sessionId: string,
): Response | null {
  const state = reservationStates.get(reservation);
  if (!state || state.runtime !== runtime || state.sessionId !== sessionId || state.phase !== "reserved") {
    return Response.json({ detail: "invalid session run reservation" }, { status: 500 });
  }
  state.phase = "streaming";
  return null;
}

function releaseReservedSessionRun(reservation: SessionRunReservation): void {
  const state = reservationStates.get(reservation);
  if (!state || state.phase !== "reserved") return;
  state.phase = "released";
  state.activeRun = null;
  state.runtime.lockedAgentSessions.delete(state.sessionId);
  releaseReservationIndex(reservation, state);
}

function releaseStreamingSessionRun(reservation: SessionRunReservation): void {
  const state = reservationStates.get(reservation);
  if (!state || state.phase !== "streaming") return;
  state.phase = "released";
  state.activeRun = null;
  state.runtime.lockedAgentSessions.delete(state.sessionId);
  releaseReservationIndex(reservation, state);
}

function releaseReservationIndex(
  reservation: SessionRunReservation,
  state: SessionRunReservationState,
): void {
  const reservations = reservationsByRuntime.get(state.runtime);
  if (reservations?.get(state.sessionId) === reservation) reservations.delete(state.sessionId);
}
