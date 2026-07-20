/**
 * Session 运行态与活动镜像字段的纯投影函数。
 *
 * agentStore 采用 dual-zone 模式：所有事实按 sessionId 存 map，
 * 活动 Session 的镜像字段（agentSession/agentPrompt/...）由这里统一推导，
 * 保证切换会话时 UI 状态一致。
 */
import type {
  AgentMessage,
  AgentSessionResponse,
  AgentSessionRun,
  AgentSessionSummary,
  QueuedFollowUp,
} from '../../types';
import type { ImageAttachment } from '../../api';

export interface SessionRunProjection extends AgentSessionRun {
  pendingToolCalls: Set<string>;
}

/** 按 sessionId 组织的数据事实（store 状态的数据子集）。 */
export interface SessionDataState {
  activeAgentSessionId: string | null;
  agentSessionById: Record<string, AgentSessionResponse>;
  agentSessionHistory: AgentSessionSummary[];
  runStateBySessionId: Record<string, SessionRunProjection>;
  draftBySessionId: Record<string, string>;
  streamingMessageBySessionId: Record<string, AgentMessage>;
  pendingImagesBySessionId: Record<string, ImageAttachment[]>;
  queuedFollowUpsBySessionId: Record<string, QueuedFollowUp[]>;
}

/** 活动 Session 的派生镜像字段。 */
export interface ActiveSessionMirror {
  agentSession: AgentSessionResponse | null;
  agentPrompt: string;
  pendingToolCalls: Set<string>;
  agentBusyKey: string | null;
  streamingMessage: AgentMessage | null;
  pendingImages: ImageAttachment[];
  queuedFollowUps: QueuedFollowUp[];
}

export const NEW_SESSION_PENDING_KEY = '__new__';

export function idleRun(sessionId: string): SessionRunProjection {
  return {
    sessionId,
    runId: null,
    status: 'idle',
    activeFlags: [],
    lastSeq: 0,
    error: null,
    pendingToolCalls: new Set(),
  };
}

export function mergeRunPayload(
  previous: SessionRunProjection | undefined,
  sessionId: string,
  run?: AgentSessionRun,
): SessionRunProjection {
  const status = run?.status ?? previous?.status ?? 'idle';
  return {
    sessionId,
    runId: run?.runId ?? previous?.runId ?? null,
    status,
    activeFlags: run?.activeFlags ?? previous?.activeFlags ?? [],
    lastSeq: run?.lastSeq ?? previous?.lastSeq ?? 0,
    error: run?.error ?? previous?.error ?? null,
    pendingToolCalls: status === 'running' ? new Set(previous?.pendingToolCalls ?? []) : new Set(),
  };
}

export function mergeHistoryRuns(
  history: AgentSessionSummary[],
  previous: Record<string, SessionRunProjection>,
): Record<string, SessionRunProjection> {
  const next = { ...previous };
  for (const item of history) {
    next[item.id] = mergeRunPayload(next[item.id], item.id, item.run);
  }
  return next;
}

export function sessionFromSummary(summary: AgentSessionSummary): AgentSessionResponse {
  return { session: summary, messages: [], run: summary.run };
}

export function visibleSession(state: SessionDataState): AgentSessionResponse | null {
  const activeId = state.activeAgentSessionId;
  if (!activeId) return null;
  const cached = state.agentSessionById[activeId];
  if (cached) return cached;
  const summary = state.agentSessionHistory.find((item) => item.id === activeId);
  return summary ? sessionFromSummary(summary) : null;
}

export function pendingImagesKey(activeId: string | null): string {
  return activeId ?? NEW_SESSION_PENDING_KEY;
}

/** 由数据事实推导活动 Session 的全部镜像字段。 */
export function activeFields(state: SessionDataState): ActiveSessionMirror {
  const activeId = state.activeAgentSessionId;
  const run = activeId ? state.runStateBySessionId[activeId] : undefined;
  const session = visibleSession(state);
  const key = pendingImagesKey(activeId);
  return {
    agentSession: session,
    agentPrompt: state.draftBySessionId[key] ?? '',
    pendingToolCalls: new Set(run?.pendingToolCalls ?? []),
    agentBusyKey: activeId && run?.status === 'running' ? activeId : null,
    streamingMessage: activeId ? state.streamingMessageBySessionId[activeId] ?? null : null,
    pendingImages: state.pendingImagesBySessionId[key] ?? [],
    queuedFollowUps: activeId ? state.queuedFollowUpsBySessionId[activeId] ?? [] : [],
  };
}

export interface AgentSelection {
  selectedAgentId: string;
  activeAgentSessionId: string | null;
}

export function selectionUpdate<S extends SessionDataState & { selectedAgentId: string }>(
  state: S,
  selection: AgentSelection,
): AgentSelection & ActiveSessionMirror {
  const next = { ...state, ...selection };
  return { ...selection, ...activeFields(next) };
}

export function responseForSession(
  state: Pick<SessionDataState, 'agentSessionById' | 'agentSessionHistory'>,
  sessionId: string,
): AgentSessionResponse {
  const cached = state.agentSessionById[sessionId];
  if (cached) return cached;
  const summary = state.agentSessionHistory.find((item) => item.id === sessionId);
  return summary ? sessionFromSummary(summary) : { session: null, messages: [] };
}

export function appendSessionMessage(
  state: Pick<SessionDataState, 'agentSessionById' | 'agentSessionHistory'>,
  sessionId: string,
  message: AgentMessage,
): Record<string, AgentSessionResponse> {
  const session = responseForSession(state, sessionId);
  return {
    ...state.agentSessionById,
    [sessionId]: {
      ...session,
      messages: [...session.messages, message],
    },
  };
}

export function cacheSession(
  cache: Record<string, AgentSessionResponse>,
  payload: AgentSessionResponse,
): Record<string, AgentSessionResponse> {
  const sessionId = payload.session?.id;
  return sessionId ? { ...cache, [sessionId]: payload } : cache;
}

export function upsertOptimisticSessionSummary(
  history: AgentSessionSummary[],
  payload: AgentSessionResponse,
  prompt: string,
  updatedAt: string,
  run: SessionRunProjection,
): AgentSessionSummary[] {
  if (!payload.session) return history;
  const existing = history.find((item) => item.id === payload.session?.id);
  const preview = (existing?.preview || prompt.replace(/[\n\r]+/g, ' ').trim()).slice(0, 120);
  const messageCount = Math.max(existing?.messageCount ?? 0, payload.messages.length, 1);
  const summary: AgentSessionSummary = existing
    ? { ...existing, updatedAt, messageCount, run }
    : {
        ...payload.session,
        active: false,
        updatedAt,
        messageCount,
        preview,
        run,
      };
  return [summary, ...history.filter((item) => item.id !== summary.id)];
}

export function replaceRunState(
  map: Record<string, SessionRunProjection>,
  sessionId: string,
  run: SessionRunProjection,
): Record<string, SessionRunProjection> {
  return { ...map, [sessionId]: run };
}
