import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { OriginSelection, OriginSessionSummary } from '../types';

const stores = vi.hoisted(() => ({
  agent: { getState: vi.fn() },
  chat: { getState: vi.fn() },
  origin: { getState: vi.fn() },
}));

vi.mock('../stores/agentStore', () => ({ useAgentStore: stores.agent }));
vi.mock('../stores/chatStore', () => ({ useChatStore: stores.chat }));
vi.mock('../stores/originStore', () => ({ useOriginStore: stores.origin }));

import { deleteOriginEntry, openOriginEntry } from './originWorkspace';

let originState: {
  origins: OriginSessionSummary[];
  selection: OriginSelection | null;
  select: ReturnType<typeof vi.fn>;
  remove: ReturnType<typeof vi.fn>;
};
let chatState: {
  activeTarget: { kind: 'origin' } | { kind: 'direct-message'; directMessageId: string } | null;
  selectOrigin: ReturnType<typeof vi.fn>;
  leaveOrigin: ReturnType<typeof vi.fn>;
  selectDirectMessage: ReturnType<typeof vi.fn>;
};

beforeEach(() => {
  vi.clearAllMocks();
  originState = {
    origins: [],
    selection: null,
    select: vi.fn(async (sessionId: string) => {
      originState.selection = { kind: 'session', sessionId };
    }),
    remove: vi.fn(),
  };
  chatState = {
    activeTarget: null,
    selectOrigin: vi.fn(() => { chatState.activeTarget = { kind: 'origin' }; }),
    leaveOrigin: vi.fn(() => { chatState.activeTarget = null; }),
    selectDirectMessage: vi.fn((directMessageId: string) => {
      chatState.activeTarget = { kind: 'direct-message', directMessageId };
    }),
  };
  stores.origin.getState.mockImplementation(() => originState);
  stores.chat.getState.mockImplementation(() => chatState);
  stores.agent.getState.mockReturnValue({
    selectedAgentId: 'agent-default',
    directMessageIdByAgentId: { 'agent-default': 'dm-default' },
  });
});

describe('Origin workspace navigation', () => {
  it('does not replace a newer selection when an earlier active deletion finishes late', async () => {
    const removal = deferred<boolean>();
    originState.origins = [originSummary('origin-a'), originSummary('origin-c')];
    originState.selection = { kind: 'session', sessionId: 'origin-a' };
    chatState.activeTarget = { kind: 'origin' };
    originState.remove.mockImplementation(async () => {
      const removed = await removal.promise;
      if (removed) originState.origins = [originSummary('origin-c')];
      return removed;
    });

    const deleting = deleteOriginEntry('origin-a');
    await vi.waitFor(() => expect(originState.remove).toHaveBeenCalledWith('origin-a'));
    await openOriginEntry('origin-b');
    removal.resolve(true);
    await deleting;

    expect(originState.selection).toEqual({ kind: 'session', sessionId: 'origin-b' });
    expect(originState.select).toHaveBeenCalledTimes(1);
    expect(originState.select).toHaveBeenCalledWith('origin-b');
  });

  it('opens the next remaining Origin after the active one is deleted', async () => {
    originState.origins = [originSummary('origin-a'), originSummary('origin-next')];
    originState.selection = { kind: 'session', sessionId: 'origin-a' };
    chatState.activeTarget = { kind: 'origin' };
    originState.remove.mockImplementation(async () => {
      originState.origins = [originSummary('origin-next')];
      originState.selection = null;
      return true;
    });

    await deleteOriginEntry('origin-a');

    expect(originState.select).toHaveBeenCalledWith('origin-next');
    expect(chatState.selectOrigin).toHaveBeenCalledOnce();
    expect(chatState.selectDirectMessage).not.toHaveBeenCalled();
  });

  it('returns to the selected Agent DM after the last active Origin is deleted', async () => {
    originState.origins = [originSummary('origin-a')];
    originState.selection = { kind: 'session', sessionId: 'origin-a' };
    chatState.activeTarget = { kind: 'origin' };
    originState.remove.mockImplementation(async () => {
      originState.origins = [];
      originState.selection = null;
      return true;
    });

    await deleteOriginEntry('origin-a');

    expect(chatState.leaveOrigin).toHaveBeenCalledOnce();
    expect(chatState.selectDirectMessage).toHaveBeenCalledWith('dm-default');
    expect(chatState.activeTarget).toEqual({ kind: 'direct-message', directMessageId: 'dm-default' });
  });
});

function originSummary(id: string): OriginSessionSummary {
  return {
    id,
    title: id,
    provider: null,
    model: 'default',
    createdAt: '2026-07-26T00:00:00.000Z',
    updatedAt: '2026-07-26T00:00:00.000Z',
    reasoningEffort: null,
    runtime: 'pi',
    capabilities: { streaming: true, abort: true, resume: true, imageInput: true, toolProgress: true },
    owner: { kind: 'origin' },
    workspace: '',
    systemPrompt: '',
    messageCount: 1,
    preview: 'hello',
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}
