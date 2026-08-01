/**
 * Session 流事件的纯归约器。
 *
 * runAgentAnalysis 把每个流事件映射为一个 AgentStreamAction（在编排层解析
 * envelope、生成 id/时间戳、维护 restoredFollowUps 等闭包旗标），本模块只做
 * 「状态 → 状态」的纯变换，不发请求、不跨 store、不产生副作用。
 * 镜像字段（agentSession/streamingMessage/...）由调用方用 activeFields 统一补齐。
 */
import type {
  AgentMessage,
  AgentSessionResponse,
  AgentSessionSummary,
  QueuedFollowUp,
} from '../../types';
import {
  appendSessionMessage,
  cacheSession,
  idleRun,
  mergeHistoryRuns,
  mergeRunPayload,
  replaceRunState,
  type SessionDataState,
} from './sessionProjection';

/** 归约器读写的状态子集（AgentState 的数据区，不含镜像字段）。 */
export type AgentStreamSlice = Pick<
  SessionDataState,
  | 'agentSessionById'
  | 'agentSessionHistory'
  | 'runStateBySessionId'
  | 'streamingMessageBySessionId'
  | 'queuedFollowUpsBySessionId'
>;

export type AgentStreamAction =
  | { type: 'message_start'; sessionId: string; id: number; createdAt: string }
  | { type: 'message_update'; sessionId: string; content: string }
  | {
      type: 'message_end';
      sessionId: string;
      message: AgentMessage;
      runId: string;
      seq: number;
      clearStreaming: boolean;
    }
  | { type: 'tool_start'; sessionId: string; toolCallId: string; runId: string; seq: number }
  | { type: 'tool_end'; sessionId: string; callId: string; runId: string; seq: number }
  | {
      type: 'agent_end';
      sessionId: string;
      error: string | null;
      runId: string;
      seq: number;
      drainedFollowUps: QueuedFollowUp[];
      restoreFollowUps: boolean;
    }
  | {
      type: 'session_update';
      sessionId: string;
      session: AgentSessionResponse;
      history: AgentSessionSummary[];
    }
  | {
      type: 'stream_error';
      sessionId: string;
      message: AgentMessage;
      error: string;
      runId: string;
      seq: number;
      drainedFollowUps: QueuedFollowUp[];
      restoreFollowUps: boolean;
    }
  | {
      type: 'stream_failure';
      sessionId: string;
      message: AgentMessage;
      error: string;
      drainedFollowUps: QueuedFollowUp[];
      restoreFollowUps: boolean;
    }
  | { type: 'run_settled'; sessionId: string };

/** 返回 null 表示无状态变化（调用方不重算镜像字段）。 */
export function applyAgentStreamEvent(
  s: AgentStreamSlice,
  action: AgentStreamAction,
): Partial<AgentStreamSlice> | null {
  const { sessionId } = action;
  switch (action.type) {
    case 'message_start': {
      return {
        streamingMessageBySessionId: {
          ...s.streamingMessageBySessionId,
          [sessionId]: {
            id: action.id,
            sessionId,
            role: 'assistant' as const,
            content: '',
            createdAt: action.createdAt,
            metadata: null,
            error: null,
          },
        },
      };
    }

    case 'message_update': {
      const current = s.streamingMessageBySessionId[sessionId];
      if (!current) return null;
      return {
        streamingMessageBySessionId: {
          ...s.streamingMessageBySessionId,
          [sessionId]: { ...current, content: action.content },
        },
      };
    }

    case 'message_end': {
      const agentSessionById = appendSessionMessage(s, sessionId, action.message);
      const previous = s.runStateBySessionId[sessionId] ?? idleRun(sessionId);
      const runStateBySessionId = replaceRunState(s.runStateBySessionId, sessionId, {
        ...previous,
        status: 'running',
        runId: action.runId,
        lastSeq: action.seq,
      });
      const streamingMessageBySessionId = { ...s.streamingMessageBySessionId };
      if (action.clearStreaming) delete streamingMessageBySessionId[sessionId];
      return { agentSessionById, runStateBySessionId, streamingMessageBySessionId };
    }

    case 'tool_start': {
      const previous = s.runStateBySessionId[sessionId] ?? idleRun(sessionId);
      const pendingToolCalls = new Set(previous.pendingToolCalls);
      pendingToolCalls.add(action.toolCallId);
      return {
        runStateBySessionId: replaceRunState(s.runStateBySessionId, sessionId, {
          ...previous,
          status: 'running',
          runId: action.runId,
          lastSeq: action.seq,
          pendingToolCalls,
        }),
      };
    }

    case 'tool_end': {
      const previous = s.runStateBySessionId[sessionId] ?? idleRun(sessionId);
      const pendingToolCalls = new Set(previous.pendingToolCalls);
      if (action.callId) pendingToolCalls.delete(action.callId);
      return {
        runStateBySessionId: replaceRunState(s.runStateBySessionId, sessionId, {
          ...previous,
          runId: action.runId,
          lastSeq: action.seq,
          pendingToolCalls,
        }),
      };
    }

    case 'agent_end': {
      const previous = s.runStateBySessionId[sessionId] ?? idleRun(sessionId);
      const runStateBySessionId = replaceRunState(s.runStateBySessionId, sessionId, {
        ...previous,
        runId: action.runId,
        lastSeq: action.seq,
        status: action.error ? 'error' : previous.status,
        error: action.error ?? previous.error,
      });
      const streamingMessageBySessionId = { ...s.streamingMessageBySessionId };
      delete streamingMessageBySessionId[sessionId];
      const queuedFollowUpsBySessionId = action.restoreFollowUps
        ? {
            ...s.queuedFollowUpsBySessionId,
            [sessionId]: [...action.drainedFollowUps, ...(s.queuedFollowUpsBySessionId[sessionId] ?? [])],
          }
        : s.queuedFollowUpsBySessionId;
      return { runStateBySessionId, queuedFollowUpsBySessionId, streamingMessageBySessionId };
    }

    case 'session_update': {
      const agentSessionById = cacheSession(s.agentSessionById, action.session);
      const runStateBySessionId = mergeHistoryRuns(action.history, {
        ...s.runStateBySessionId,
        [sessionId]: mergeRunPayload(s.runStateBySessionId[sessionId], sessionId, action.session.run),
      });
      return { agentSessionById, runStateBySessionId, agentSessionHistory: action.history };
    }

    case 'stream_error': {
      const agentSessionById = appendSessionMessage(s, sessionId, action.message);
      const previous = s.runStateBySessionId[sessionId] ?? idleRun(sessionId);
      const runStateBySessionId = replaceRunState(s.runStateBySessionId, sessionId, {
        ...previous,
        status: 'error',
        error: action.error,
        runId: action.runId,
        lastSeq: action.seq,
      });
      const queuedFollowUpsBySessionId = action.restoreFollowUps
        ? {
            ...s.queuedFollowUpsBySessionId,
            [sessionId]: [...action.drainedFollowUps, ...(s.queuedFollowUpsBySessionId[sessionId] ?? [])],
          }
        : s.queuedFollowUpsBySessionId;
      const streamingMessageBySessionId = { ...s.streamingMessageBySessionId };
      delete streamingMessageBySessionId[sessionId];
      return { agentSessionById, runStateBySessionId, queuedFollowUpsBySessionId, streamingMessageBySessionId };
    }

    case 'stream_failure': {
      const agentSessionById = appendSessionMessage(s, sessionId, action.message);
      const previous = s.runStateBySessionId[sessionId] ?? idleRun(sessionId);
      const runStateBySessionId = replaceRunState(s.runStateBySessionId, sessionId, {
        ...previous,
        status: 'error',
        error: action.error,
        pendingToolCalls: new Set<string>(),
      });
      const queuedFollowUpsBySessionId = action.restoreFollowUps
        ? {
            ...s.queuedFollowUpsBySessionId,
            [sessionId]: [...action.drainedFollowUps, ...(s.queuedFollowUpsBySessionId[sessionId] ?? [])],
          }
        : s.queuedFollowUpsBySessionId;
      const streamingMessageBySessionId = { ...s.streamingMessageBySessionId };
      delete streamingMessageBySessionId[sessionId];
      return { agentSessionById, runStateBySessionId, queuedFollowUpsBySessionId, streamingMessageBySessionId };
    }

    case 'run_settled': {
      const previous = s.runStateBySessionId[sessionId] ?? idleRun(sessionId);
      const runStateBySessionId = replaceRunState(s.runStateBySessionId, sessionId, {
        ...previous,
        status: previous.status === 'error' ? 'error' : 'idle',
        pendingToolCalls: new Set<string>(),
      });
      const streamingMessageBySessionId = { ...s.streamingMessageBySessionId };
      delete streamingMessageBySessionId[sessionId];
      return { runStateBySessionId, streamingMessageBySessionId };
    }
  }
}
