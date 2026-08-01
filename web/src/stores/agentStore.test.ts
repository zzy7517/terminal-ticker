import { describe, expect, it, vi } from 'vitest';
import type {
  AgentDirectMessage,
  AgentMessage,
  AgentSession,
  AgentSessionResponse,
  AgentSessionRun,
  AgentSessionSummary,
  AgentStreamEvent,
  AgentStreamPayload,
  MarketState,
  QueuedFollowUp,
} from '../types';
import { AgentStreamDisconnectError } from '../api';
import { createAgentStore, type AgentStoreDependencies } from './agentStore';

type AgentStore = ReturnType<typeof createAgentStore>;
type StreamAgentMessage = AgentStoreDependencies['streamAgentMessage'];

const NOW = '2026-08-01T00:00:00.000Z';
const CAPABILITIES = { streaming: true, abort: true, resume: true, imageInput: true, toolProgress: true };
const MARKET_STATE = { type: 'state', updatedAt: NOW } as MarketState;

/**
 * 未被显式注入的依赖一旦被调用就让测试失败，保证 store 在测试里完全脱网。
 * 返回值声明为 never，这样它能填进任意一个依赖位。
 */
function unreachable(name: string): never {
  return ((): never => {
    throw new Error(`${name} must not be called in this test`);
  }) as unknown as never;
}

function createStore(overrides: Partial<AgentStoreDependencies> = {}): AgentStore {
  return createAgentStore({
    fetchAgents: async () => ({ agents: [] }),
    createAgent: unreachable('createAgent'),
    updateAgent: unreachable('updateAgent'),
    deleteAgent: unreachable('deleteAgent'),
    fetchAgentSessions: unreachable('fetchAgentSessions'),
    fetchAgentSession: unreachable('fetchAgentSession'),
    deleteAgentSessionById: unreachable('deleteAgentSessionById'),
    fetchAgentDirectMessages: unreachable('fetchAgentDirectMessages'),
    sendAgentDirectMessage: unreachable('sendAgentDirectMessage'),
    setDirectMessageReaction: unreachable('setDirectMessageReaction'),
    streamAgentMessage: unreachable('streamAgentMessage'),
    fetchAgentModelRegistry: unreachable('fetchAgentModelRegistry'),
    randomAvatarSeed: () => 'avatar-seed',
    setMarketState: () => {},
    loadDirectMessageWorkspace: async () => ({
      bindSelectedDirectMessage: () => {},
      markDirectMessageReadIfActive: () => {},
    }),
    now: () => NOW,
    ...overrides,
  });
}

function agentSession(id: string, overrides: Partial<AgentSession> = {}): AgentSession {
  return {
    id,
    title: `Session ${id}`,
    provider: 'anthropic',
    model: 'sonnet',
    createdAt: NOW,
    updatedAt: NOW,
    reasoningEffort: null,
    runtime: 'pi',
    capabilities: CAPABILITIES,
    active: false,
    apiMode: null,
    agentId: 'alpha',
    agentName: 'Alpha',
    ...overrides,
  };
}

function sessionResponse(id: string, messages: AgentMessage[] = []): AgentSessionResponse {
  return { session: agentSession(id), messages };
}

function summary(id: string, run?: AgentSessionRun): AgentSessionSummary {
  return { ...agentSession(id), messageCount: 1, preview: 'hello', run };
}

function runPayload(sessionId: string, status: AgentSessionRun['status']): AgentSessionRun {
  return { sessionId, runId: 'run-1', status, activeFlags: [], lastSeq: 1, error: null };
}

function followUp(id: string, content: string): QueuedFollowUp {
  return { id, content, images: [], createdAt: NOW };
}

function directMessage(id: string, dmSeq: number): AgentDirectMessage {
  return {
    id,
    directMessageId: 'dm-1',
    dmSeq,
    authorType: 'human',
    authorId: 'human',
    kind: 'text',
    content: `message ${id}`,
    createdAtMs: dmSeq,
    editedAtMs: null,
    deletedAtMs: null,
    importKey: null,
    reactions: [],
  };
}

function envelope(sessionId: string, seq: number, event: AgentStreamPayload, runId = 'run-1'): AgentStreamEvent {
  return { sessionId, runId, seq, event };
}

function assistantFrame(content: string) {
  return { role: 'assistant' as const, content };
}

/** 活动 Session 的镜像字段快照，用于断言 dual-zone 投影。 */
function mirror(store: AgentStore) {
  const state = store.getState();
  return {
    activeAgentSessionId: state.activeAgentSessionId,
    streamingMessage: state.streamingMessage?.content ?? null,
    agentPrompt: state.agentPrompt,
    pendingToolCalls: [...state.pendingToolCalls],
    agentBusyKey: state.agentBusyKey,
    queuedFollowUps: state.queuedFollowUps.map((item) => item.content),
  };
}

describe('Agent store streaming turn', () => {
  it('projects a full streaming turn into the transcript and settles the run', async () => {
    let store!: AgentStore;
    const prompts: string[] = [];
    const midFlight: Array<ReturnType<typeof mirror>> = [];
    const stream: StreamAgentMessage = async (sessionId, prompt, _options, onEvent) => {
      prompts.push(prompt);
      onEvent(envelope(sessionId, 1, { type: 'message_start', message: assistantFrame('') }));
      onEvent(envelope(sessionId, 2, { type: 'message_update', message: assistantFrame(''), delta: '第一段' }));
      onEvent(envelope(sessionId, 3, { type: 'message_update', message: assistantFrame(''), delta: '第二段' }));
      midFlight.push(mirror(store));
      onEvent(envelope(sessionId, 4, { type: 'message_end', message: assistantFrame('第一段第二段') }));
      onEvent(envelope(sessionId, 5, { type: 'agent_end', error: null }));
    };
    store = createStore({ streamAgentMessage: stream });
    store.getState().setAgentSession(sessionResponse('s1'));
    store.getState().setAgentPrompt('分析 SPY');

    await store.getState().runAgentAnalysis('s1');

    expect(prompts).toEqual(['分析 SPY']);
    expect(midFlight[0]).toMatchObject({
      streamingMessage: '第一段第二段',
      agentBusyKey: 's1',
      agentPrompt: '',
    });
    expect(store.getState().agentSession?.messages.map((item) => [item.role, item.content])).toEqual([
      ['user', '分析 SPY'],
      ['assistant', '第一段第二段'],
    ]);
    expect(store.getState().streamingMessage).toBeNull();
    expect(store.getState().agentBusyKey).toBeNull();
    expect(store.getState().runStateBySessionId.s1).toMatchObject({ status: 'idle', lastSeq: 5 });
    expect(store.getState().agentSessionHistory[0]).toMatchObject({ id: 's1', preview: '分析 SPY' });
  });

  it('keeps live stream state on its own session while the user reads another one', async () => {
    let store!: AgentStore;
    const observed: Array<ReturnType<typeof mirror>> = [];
    const stream: StreamAgentMessage = async (sessionId, _prompt, _options, onEvent) => {
      onEvent(envelope(sessionId, 1, { type: 'message_start', message: assistantFrame('') }));
      onEvent(envelope(sessionId, 2, { type: 'message_update', message: assistantFrame(''), delta: '进行中' }));
      onEvent(envelope(sessionId, 3, {
        type: 'tool_execution_start',
        toolCall: { id: 'call-1', name: 'shell', arguments: {} },
      }));
      await store.getState().resumeAgentConversation('s2');
      observed.push(mirror(store));
      await store.getState().resumeAgentConversation('s1');
      observed.push(mirror(store));
      onEvent(envelope(sessionId, 4, { type: 'agent_end', error: null }));
    };
    store = createStore({ streamAgentMessage: stream });
    store.getState().setAgentSession(sessionResponse('s2'));
    store.getState().setAgentPrompt('s2 的草稿');
    store.getState().setAgentSession(sessionResponse('s1'));
    store.getState().setAgentPrompt('分析 s1');

    await store.getState().runAgentAnalysis('s1');

    expect(observed[0]).toEqual({
      activeAgentSessionId: 's2',
      streamingMessage: null,
      agentPrompt: 's2 的草稿',
      pendingToolCalls: [],
      agentBusyKey: null,
      queuedFollowUps: [],
    });
    expect(observed[1]).toEqual({
      activeAgentSessionId: 's1',
      streamingMessage: '进行中',
      agentPrompt: '',
      pendingToolCalls: ['call-1'],
      agentBusyKey: 's1',
      queuedFollowUps: [],
    });
    expect(store.getState().draftBySessionId.s2).toBe('s2 的草稿');
  });

  it('tracks concurrent tool calls and drops them when the run settles', async () => {
    let store!: AgentStore;
    const observed: string[][] = [];
    const stream: StreamAgentMessage = async (sessionId, _prompt, _options, onEvent) => {
      onEvent(envelope(sessionId, 1, {
        type: 'tool_execution_start',
        toolCall: { id: 'call-1', name: 'shell', arguments: {} },
      }));
      onEvent(envelope(sessionId, 2, {
        type: 'tool_execution_start',
        toolCall: { id: 'call-2', name: 'read_file', arguments: {} },
      }));
      observed.push([...store.getState().pendingToolCalls]);
      onEvent(envelope(sessionId, 3, {
        type: 'tool_execution_end',
        toolCall: { id: 'call-1', name: 'shell', arguments: {} },
        toolResult: { callId: 'call-1', name: 'shell', output: 'ok', error: false },
      }));
      observed.push([...store.getState().pendingToolCalls]);
      onEvent(envelope(sessionId, 4, { type: 'agent_end', error: null }));
    };
    store = createStore({ streamAgentMessage: stream });
    store.getState().setAgentSession(sessionResponse('s1'));
    store.getState().setAgentPrompt('跑一下');

    await store.getState().runAgentAnalysis('s1');

    expect(observed).toEqual([['call-1', 'call-2'], ['call-2']]);
    expect([...store.getState().pendingToolCalls]).toEqual([]);
  });

  it('routes a session_update snapshot to the market store and adopts every history run', async () => {
    let store!: AgentStore;
    const setMarketState = vi.fn();
    const stream: StreamAgentMessage = async (sessionId, _prompt, _options, onEvent) => {
      onEvent(envelope(sessionId, 1, {
        type: 'session_update',
        session: sessionResponse('s1'),
        history: { sessions: [summary('s1'), summary('s9', runPayload('s9', 'running'))] },
        state: MARKET_STATE,
      }));
      onEvent(envelope(sessionId, 2, { type: 'agent_end', error: null }));
    };
    store = createStore({ streamAgentMessage: stream, setMarketState });
    store.getState().setAgentSession(sessionResponse('s1'));
    store.getState().setAgentPrompt('刷新');

    await store.getState().runAgentAnalysis('s1');

    expect(setMarketState).toHaveBeenCalledExactlyOnceWith(MARKET_STATE);
    expect(store.getState().runStateBySessionId.s9).toMatchObject({ status: 'running', runId: 'run-1' });
    expect(store.getState().agentSessionHistory.map((item) => item.id)).toEqual(['s1', 's9']);
  });
});

describe('Agent store follow-up queue', () => {
  it('queues a message typed during a run instead of starting a second one', async () => {
    let store!: AgentStore;
    let queuedMidRun: ReturnType<typeof mirror> | null = null;
    let turns = 0;
    const stream = vi.fn<StreamAgentMessage>(async (sessionId, _prompt, _options, onEvent) => {
      turns += 1;
      if (turns === 1) {
        store.getState().setAgentPrompt('运行中追问');
        store.getState().addPendingImage({ data: 'img', mimeType: 'image/png' });
        await store.getState().runAgentAnalysis('s1');
        queuedMidRun = mirror(store);
      }
      onEvent(envelope(sessionId, 1, { type: 'agent_end', error: null }));
    });
    store = createStore({ streamAgentMessage: stream });
    store.getState().setAgentSession(sessionResponse('s1'));
    store.getState().setAgentPrompt('第一个问题');

    await store.getState().runAgentAnalysis('s1');

    // The queued turn drains automatically once the first one completes.
    expect(stream.mock.calls.map((call) => call[1])).toEqual(['第一个问题', '运行中追问']);
    expect(queuedMidRun).toMatchObject({ queuedFollowUps: ['运行中追问'], agentPrompt: '', pendingToolCalls: [] });
    expect(store.getState().queuedFollowUps).toEqual([]);
    expect(store.getState().pendingImages).toEqual([]);
    expect(stream.mock.calls[1][2]).toEqual({ images: [{ data: 'img', mimeType: 'image/png' }] });
  });

  it('does not auto-retry a failed run, and keeps the queue for the user to resend', async () => {
    let store!: AgentStore;
    const stream = vi.fn<StreamAgentMessage>(async (sessionId, _prompt, _options, onEvent) => {
      store.getState().setAgentPrompt('运行中追问');
      await store.getState().runAgentAnalysis('s1');
      onEvent(envelope(sessionId, 1, { type: 'error', error: 'model refused' }));
    });
    store = createStore({ streamAgentMessage: stream });
    store.getState().setAgentSession(sessionResponse('s1'));
    store.getState().setAgentPrompt('第一个问题');

    await store.getState().runAgentAnalysis('s1');

    expect(stream).toHaveBeenCalledOnce();
    expect(store.getState().runStateBySessionId.s1).toMatchObject({ status: 'error', error: 'model refused' });
    const transcript = store.getState().agentSession?.messages ?? [];
    expect(transcript[transcript.length - 1]).toMatchObject({
      role: 'assistant',
      content: 'model refused',
      error: 'model refused',
    });
    expect(store.getState().queuedFollowUps.map((item) => item.content)).toEqual(['运行中追问']);
  });

  it('gives drained follow-ups back when the request itself fails', async () => {
    let store!: AgentStore;
    const stream = vi.fn<StreamAgentMessage>(async () => {
      throw new Error('socket closed');
    });
    store = createStore({ streamAgentMessage: stream });
    store.getState().setAgentSession(sessionResponse('s1'));
    store.setState({ queuedFollowUpsBySessionId: { s1: [followUp('queued', '先排队的')] } });

    await store.getState().runAgentAnalysis('s1');

    expect(stream).toHaveBeenCalledExactlyOnceWith('s1', '先排队的', { images: undefined }, expect.any(Function));
    expect(store.getState().queuedFollowUpsBySessionId.s1.map((item) => item.content)).toEqual(['先排队的']);
    expect(store.getState().runStateBySessionId.s1).toMatchObject({ status: 'error', error: 'socket closed' });
  });

  it('keeps drained follow-ups consumed when only the stream transport dropped', async () => {
    let store!: AgentStore;
    const stream: StreamAgentMessage = async () => {
      throw new AgentStreamDisconnectError();
    };
    store = createStore({ streamAgentMessage: stream });
    store.getState().setAgentSession(sessionResponse('s1'));
    store.setState({ queuedFollowUpsBySessionId: { s1: [followUp('queued', '先排队的')] } });

    await store.getState().runAgentAnalysis('s1');

    // The backend already accepted them, so replaying would double-send.
    expect(store.getState().queuedFollowUpsBySessionId.s1).toEqual([]);
    expect(store.getState().runStateBySessionId.s1.status).toBe('error');
  });

  it('rejects an oversized image batch without sending or discarding the attachments', async () => {
    const stream = vi.fn<StreamAgentMessage>(async () => {});
    const store = createStore({ streamAgentMessage: stream });
    store.getState().setAgentSession(sessionResponse('s1'));
    store.getState().setAgentPrompt('看这些图');
    for (let index = 0; index < 11; index += 1) {
      store.getState().addPendingImage({ data: `img-${index}`, mimeType: 'image/png' });
    }

    await store.getState().runAgentAnalysis('s1');

    expect(stream).not.toHaveBeenCalled();
    expect(store.getState().runStateBySessionId.s1).toMatchObject({
      status: 'error',
      error: 'Queued follow-up images exceed the 10-image request limit',
    });
    expect(store.getState().pendingImages).toHaveLength(11);
    expect(store.getState().agentPrompt).toBe('看这些图');
  });
});

describe('Agent store composer and session list', () => {
  it('sends an empty-session composer through the Direct Message fabric', async () => {
    const sendAgentDirectMessage = vi.fn<AgentStoreDependencies['sendAgentDirectMessage']>(async () => ({
      message: directMessage('m2', 2),
      target: { kind: 'direct-message' as const, directMessageId: 'dm-1' },
    }));
    const markDirectMessageReadIfActive = vi.fn();
    const store = createStore({
      sendAgentDirectMessage,
      fetchAgentDirectMessages: async () => ({
        directMessage: { id: 'dm-1' },
        target: { kind: 'direct-message', directMessageId: 'dm-1' },
        messages: [directMessage('m2', 2), directMessage('m1', 1)],
        nextBeforeSeq: null,
      }),
      loadDirectMessageWorkspace: async () => ({
        bindSelectedDirectMessage: () => {},
        markDirectMessageReadIfActive,
      }),
    });
    store.getState().setAgentPrompt('  盘前怎么看  ');
    store.getState().addPendingImage({ data: 'img', mimeType: 'image/png' });

    await store.getState().runAgentAnalysis(undefined, { skillNames: ['macro'] });

    expect(sendAgentDirectMessage).toHaveBeenCalledExactlyOnceWith(
      'default',
      '盘前怎么看',
      [{ data: 'img', mimeType: 'image/png' }],
      ['macro'],
    );
    expect(store.getState().agentPrompt).toBe('');
    expect(store.getState().pendingImages).toEqual([]);
    // The API returns newest-first; the transcript renders oldest-first.
    expect(store.getState().directMessagesByAgentId.default.map((item) => item.id)).toEqual(['m1', 'm2']);
    expect(markDirectMessageReadIfActive).toHaveBeenCalledWith('default');
  });

  it('resumes a cached session without refetching it', async () => {
    const fetchAgentSession = vi.fn<AgentStoreDependencies['fetchAgentSession']>();
    const store = createStore({ fetchAgentSession });
    store.getState().setAgentSession(sessionResponse('s2'));
    store.getState().setAgentSession(sessionResponse('s1', [
      { id: 1, sessionId: 's1', role: 'user', content: '历史消息', createdAt: NOW, metadata: null, error: null },
    ]));
    store.getState().setAgentSessionHistory([summary('s1'), summary('s2')]);

    await store.getState().resumeAgentConversation('s2');

    expect(fetchAgentSession).not.toHaveBeenCalled();
    expect(store.getState().activeAgentSessionId).toBe('s2');
    expect(store.getState().selectedAgentId).toBe('alpha');
    expect(store.getState().agentSession?.messages).toEqual([]);
  });

  it('refuses to delete a session while its run is active', async () => {
    const deleteAgentSessionById = vi.fn<AgentStoreDependencies['deleteAgentSessionById']>();
    const store = createStore({ deleteAgentSessionById });
    store.getState().setAgentSession({ ...sessionResponse('s1'), run: runPayload('s1', 'running') });

    await store.getState().deleteAgentConversation('s1');

    expect(deleteAgentSessionById).not.toHaveBeenCalled();
    expect(store.getState().agentSessionById.s1).toBeDefined();
  });

  it('drops every trace of a deleted session and opens the next one', async () => {
    const setMarketState = vi.fn();
    const store = createStore({
      setMarketState,
      deleteAgentSessionById: async () => ({
        session: sessionResponse('s1'),
        history: { sessions: [summary('s2')] },
        state: MARKET_STATE,
      }),
    });
    store.getState().setAgentSession(sessionResponse('s2'));
    store.getState().setAgentSession(sessionResponse('s1'));
    store.getState().setAgentPrompt('未发送的草稿');
    store.setState({
      queuedFollowUpsBySessionId: { s1: [followUp('queued', '排队中')] },
      streamingMessageBySessionId: {
        s1: { id: -1, sessionId: 's1', role: 'assistant', content: '半截', createdAt: NOW, metadata: null, error: null },
      },
    });

    await store.getState().deleteAgentConversation('s1');

    expect(setMarketState).toHaveBeenCalledExactlyOnceWith(MARKET_STATE);
    expect(store.getState().agentSessionById.s1).toBeUndefined();
    expect(store.getState().runStateBySessionId.s1).toBeUndefined();
    expect(store.getState().draftBySessionId.s1).toBeUndefined();
    expect(store.getState().queuedFollowUpsBySessionId.s1).toBeUndefined();
    expect(store.getState().streamingMessageBySessionId.s1).toBeUndefined();
    expect(store.getState().activeAgentSessionId).toBe('s2');
    expect(store.getState().agentSession?.session?.id).toBe('s2');
  });

  it('mints a new avatar seed through the injected generator', async () => {
    const updateAgent = vi.fn<AgentStoreDependencies['updateAgent']>(async (_agentId, patch) => ({
      agent: { ...patch, id: 'alpha' } as never,
      agents: [],
    }));
    const store = createStore({ updateAgent, randomAvatarSeed: () => 'fixed-seed' });

    await store.getState().rerollAgentAvatar('alpha');

    expect(updateAgent).toHaveBeenCalledExactlyOnceWith('alpha', { avatarSeed: 'fixed-seed' });
  });
});
