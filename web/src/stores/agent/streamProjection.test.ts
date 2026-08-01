import { describe, expect, it } from 'vitest';
import type {
  AgentMessage,
  AgentSessionSummary,
  QueuedFollowUp,
} from '../../types';
import { idleRun, type SessionRunProjection } from './sessionProjection';
import { applyAgentStreamEvent, type AgentStreamSlice } from './streamProjection';

function slice(overrides: Partial<AgentStreamSlice> = {}): AgentStreamSlice {
  return {
    agentSessionById: {},
    agentSessionHistory: [],
    runStateBySessionId: {},
    streamingMessageBySessionId: {},
    queuedFollowUpsBySessionId: {},
    ...overrides,
  };
}

function message(sessionId: string, overrides: Partial<AgentMessage> = {}): AgentMessage {
  return {
    id: 1,
    sessionId,
    role: 'assistant',
    content: '',
    createdAt: '2026-08-01T00:00:00.000Z',
    metadata: null,
    error: null,
    ...overrides,
  };
}

function summary(id: string): AgentSessionSummary {
  return {
    id,
    title: 'Session',
    provider: 'anthropic',
    model: 'sonnet',
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
    reasoningEffort: null,
    runtime: 'pi',
    capabilities: { streaming: true, abort: true, resume: true, imageInput: true, toolProgress: true },
    active: false,
    apiMode: null,
    agentId: 'alpha',
    agentName: 'Alpha',
    messageCount: 1,
    preview: 'hello',
  };
}

function followUp(id: string, content: string): QueuedFollowUp {
  return { id, content, images: [], createdAt: '2026-08-01T00:00:00.000Z' };
}

function running(sessionId: string, overrides: Partial<SessionRunProjection> = {}): SessionRunProjection {
  return { ...idleRun(sessionId), status: 'running', runId: 'run-1', ...overrides };
}

describe('agent stream projection', () => {
  it('ignores a delta that arrives after its streaming buffer was dropped', () => {
    const update = applyAgentStreamEvent(slice(), {
      type: 'message_update',
      sessionId: 's1',
      content: 'late delta',
    });

    expect(update).toBeNull();
  });

  it('accumulates deltas into one buffer per session', () => {
    const started = applyAgentStreamEvent(
      slice({ streamingMessageBySessionId: { s2: message('s2', { content: 'other session' }) } }),
      { type: 'message_start', sessionId: 's1', id: -1, createdAt: '2026-08-01T00:00:01.000Z' },
    );
    const updated = applyAgentStreamEvent(slice(started!), {
      type: 'message_update',
      sessionId: 's1',
      content: '第一段第二段',
    });

    expect(updated!.streamingMessageBySessionId!.s1).toMatchObject({
      id: -1,
      sessionId: 's1',
      role: 'assistant',
      content: '第一段第二段',
      createdAt: '2026-08-01T00:00:01.000Z',
    });
    expect(updated!.streamingMessageBySessionId!.s2.content).toBe('other session');
  });

  it('appends a finished message to a session known only through history', () => {
    const update = applyAgentStreamEvent(slice({ agentSessionHistory: [summary('s1')] }), {
      type: 'message_end',
      sessionId: 's1',
      message: message('s1', { content: '完整回答' }),
      runId: 'run-1',
      seq: 4,
      clearStreaming: true,
    });

    expect(update!.agentSessionById!.s1.messages).toEqual([message('s1', { content: '完整回答' })]);
    expect(update!.agentSessionById!.s1.session?.id).toBe('s1');
    expect(update!.runStateBySessionId!.s1).toMatchObject({ status: 'running', runId: 'run-1', lastSeq: 4 });
  });

  it('resolves only the tool call that ended, leaving concurrent calls pending', () => {
    const withTwoCalls = slice({
      runStateBySessionId: {
        s1: running('s1', { pendingToolCalls: new Set(['call-1', 'call-2']) }),
      },
    });

    const update = applyAgentStreamEvent(withTwoCalls, {
      type: 'tool_end',
      sessionId: 's1',
      callId: 'call-1',
      runId: 'run-1',
      seq: 7,
    });

    expect(update!.runStateBySessionId!.s1.pendingToolCalls).toEqual(new Set(['call-2']));
    expect(withTwoCalls.runStateBySessionId.s1.pendingToolCalls).toEqual(new Set(['call-1', 'call-2']));
  });

  it('replays drained follow-ups ahead of anything queued during the failed run', () => {
    const update = applyAgentStreamEvent(
      slice({
        runStateBySessionId: { s1: running('s1') },
        streamingMessageBySessionId: { s1: message('s1', { content: 'partial' }) },
        queuedFollowUpsBySessionId: { s1: [followUp('during', '运行中入队')] },
      }),
      {
        type: 'agent_end',
        sessionId: 's1',
        error: 'runtime exploded',
        runId: 'run-1',
        seq: 9,
        drainedFollowUps: [followUp('drained', '发送时带走的')],
        restoreFollowUps: true,
      },
    );

    expect(update!.queuedFollowUpsBySessionId!.s1.map((item) => item.id)).toEqual(['drained', 'during']);
    expect(update!.runStateBySessionId!.s1).toMatchObject({ status: 'error', error: 'runtime exploded' });
    expect(update!.streamingMessageBySessionId!.s1).toBeUndefined();
  });

  it('leaves the queue alone when the run already restored its follow-ups', () => {
    const queued = { s1: [followUp('during', '运行中入队')] };
    const update = applyAgentStreamEvent(
      slice({ runStateBySessionId: { s1: running('s1') }, queuedFollowUpsBySessionId: queued }),
      {
        type: 'agent_end',
        sessionId: 's1',
        error: 'second failure frame',
        runId: 'run-1',
        seq: 10,
        drainedFollowUps: [followUp('drained', '发送时带走的')],
        restoreFollowUps: false,
      },
    );

    expect(update!.queuedFollowUpsBySessionId).toBe(queued);
  });

  it('clears pending tool calls on a transport failure but keeps them on a protocol error', () => {
    const pending = { s1: running('s1', { pendingToolCalls: new Set(['call-1']) }) };

    const protocolError = applyAgentStreamEvent(slice({ runStateBySessionId: pending }), {
      type: 'stream_error',
      sessionId: 's1',
      message: message('s1', { content: 'tool blew up', error: 'tool blew up' }),
      error: 'tool blew up',
      runId: 'run-1',
      seq: 11,
      drainedFollowUps: [],
      restoreFollowUps: false,
    });
    const transportFailure = applyAgentStreamEvent(slice({ runStateBySessionId: pending }), {
      type: 'stream_failure',
      sessionId: 's1',
      message: message('s1', { content: 'socket closed', error: 'socket closed' }),
      error: 'socket closed',
      drainedFollowUps: [],
      restoreFollowUps: false,
    });

    expect(protocolError!.runStateBySessionId!.s1.pendingToolCalls).toEqual(new Set(['call-1']));
    expect(transportFailure!.runStateBySessionId!.s1.pendingToolCalls).toEqual(new Set());
    expect(protocolError!.agentSessionById!.s1.messages).toHaveLength(1);
    expect(transportFailure!.runStateBySessionId!.s1).toMatchObject({ status: 'error', error: 'socket closed' });
  });

  it('settles a healthy run to idle and preserves a failed one as an error', () => {
    const healthy = applyAgentStreamEvent(
      slice({
        runStateBySessionId: { s1: running('s1', { pendingToolCalls: new Set(['call-1']) }) },
        streamingMessageBySessionId: { s1: message('s1') },
      }),
      { type: 'run_settled', sessionId: 's1' },
    );
    const failed = applyAgentStreamEvent(
      slice({ runStateBySessionId: { s1: running('s1', { status: 'error', error: 'boom' }) } }),
      { type: 'run_settled', sessionId: 's1' },
    );

    expect(healthy!.runStateBySessionId!.s1).toMatchObject({ status: 'idle' });
    expect(healthy!.runStateBySessionId!.s1.pendingToolCalls).toEqual(new Set());
    expect(healthy!.streamingMessageBySessionId!.s1).toBeUndefined();
    expect(failed!.runStateBySessionId!.s1).toMatchObject({ status: 'error', error: 'boom' });
  });

  it('adopts run state for every session carried by a history refresh', () => {
    const update = applyAgentStreamEvent(slice({ runStateBySessionId: { s1: running('s1') } }), {
      type: 'session_update',
      sessionId: 's1',
      session: { session: null, messages: [] },
      history: [
        { ...summary('s1'), run: { sessionId: 's1', runId: 'run-1', status: 'running', activeFlags: [], lastSeq: 5, error: null } },
        { ...summary('s9'), run: { sessionId: 's9', runId: 'run-9', status: 'running', activeFlags: [], lastSeq: 2, error: null } },
      ],
    });

    expect(update!.runStateBySessionId!.s9).toMatchObject({ status: 'running', runId: 'run-9', lastSeq: 2 });
    expect(update!.agentSessionHistory).toHaveLength(2);
    // A null session payload carries no id, so the transcript cache must stay untouched.
    expect(update!.agentSessionById).toEqual({});
  });
});
