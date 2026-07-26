import { describe, expect, it, vi } from 'vitest';
import type {
  OriginDraftConfig,
  OriginSessionHistoryResponse,
  OriginSessionResponse,
  OriginSessionSummary,
  StartOriginInput,
  OriginStreamEvent,
} from '../types';
import type { OriginPreferencesAdapter, OriginPreferencesSnapshot } from './origin/preferences';
import { HttpResponseError } from '../api/http';
import { createOriginStore } from './originStore';

function preferences(initial: Partial<OriginPreferencesSnapshot> = {}): OriginPreferencesAdapter {
  let snapshot: OriginPreferencesSnapshot = {
    lastConfig: initial.lastConfig ?? null,
    lastOpenedSessionId: initial.lastOpenedSessionId ?? null,
  };
  return {
    load: () => ({
      lastConfig: snapshot.lastConfig ? { ...snapshot.lastConfig } : null,
      lastOpenedSessionId: snapshot.lastOpenedSessionId,
    }),
    saveLastConfig: (config) => { snapshot = { ...snapshot, lastConfig: { ...config } }; },
    saveLastOpenedSessionId: (sessionId) => { snapshot = { ...snapshot, lastOpenedSessionId: sessionId }; },
  };
}

function config(overrides: Partial<OriginDraftConfig> = {}): OriginDraftConfig {
  return {
    runtime: 'pi', provider: null, model: null, reasoningEffort: null, ...overrides,
  };
}

function sessionResponse(id: string, overrides: Partial<OriginDraftConfig> = {}): OriginSessionResponse {
  const selected = config(overrides);
  return {
    session: {
      id,
      title: 'Existing Origin',
      provider: selected.provider,
      model: selected.model ?? 'default',
      createdAt: '2026-07-26T00:00:00.000Z',
      updatedAt: '2026-07-26T00:00:00.000Z',
      reasoningEffort: selected.reasoningEffort,
      runtime: selected.runtime,
      capabilities: { streaming: true, abort: true, resume: true, imageInput: true, toolProgress: true },
      owner: { kind: 'origin' },
      workspace: '',
      systemPrompt: '',
    },
    messages: [],
  };
}

function summary(id: string): OriginSessionSummary {
  return {
    ...sessionResponse(id).session!,
    messageCount: 1,
    preview: 'hello',
  };
}

function sessionRun(
  sessionId: string,
  status: 'idle' | 'running' | 'error',
  runId: string | null = null,
) {
  return { sessionId, runId, status, activeFlags: [], lastSeq: runId ? 1 : 0, error: null };
}

describe('Origin store draft lifecycle', () => {
  it('opens fresh in-memory drafts seeded only from the last used config', () => {
    const fetchOrigins = vi.fn();
    const remembered = config({
      runtime: 'claude-code', model: 'opus', reasoningEffort: 'high',
    });
    const ids = ['draft-1', 'draft-2'];
    const store = createOriginStore({
      preferences: preferences({ lastConfig: remembered, lastOpenedSessionId: 'origin-old' }),
      createMaterializationId: () => ids.shift()!,
      fetchOrigins,
    });

    const first = store.getState().newDraft();
    store.getState().setMessage('discard me');
    store.getState().setImages([{ data: 'image', mimeType: 'image/png' }]);
    store.getState().setSkillNames(['codebase-design']);
    const second = store.getState().newDraft();

    expect(first.materializationId).toBe('draft-1');
    expect(second).toEqual({
      materializationId: 'draft-2',
      config: remembered,
      message: '',
      images: [],
      skillNames: [],
      phase: 'editing',
    });
    expect(fetchOrigins).not.toHaveBeenCalled();
  });

  it('preserves the complete draft when start fails before materialization', async () => {
    const prefs = preferences();
    const streamNewOrigin = vi.fn(async () => { throw new Error('runtime unavailable'); });
    const store = createOriginStore({
      preferences: prefs,
      createMaterializationId: () => 'draft-failed',
      streamNewOrigin,
    });
    store.getState().newDraft(config({ runtime: 'cursor', model: 'auto' }));
    store.getState().setMessage('  keep this prompt  ');
    store.getState().setImages([{ data: 'image', mimeType: 'image/jpeg' }]);
    store.getState().setSkillNames(['codebase-design']);

    await store.getState().send();

    expect(streamNewOrigin).toHaveBeenCalledOnce();
    expect(store.getState().selection).toEqual({
      kind: 'draft',
      draft: {
        materializationId: 'draft-failed',
        config: config({ runtime: 'cursor', model: 'auto' }),
        message: '  keep this prompt  ',
        images: [{ data: 'image', mimeType: 'image/jpeg' }],
        skillNames: ['codebase-design'],
        phase: 'editing',
      },
    });
    expect(store.getState().error).toBe('runtime unavailable');
    expect(prefs.load().lastConfig).toBeNull();
  });

  it('starts an Origin from an image without requiring message text', async () => {
    const streamNewOrigin = vi.fn(async () => ({ kind: 'streamed' as const }));
    const store = createOriginStore({
      preferences: preferences(),
      createMaterializationId: () => 'draft-image',
      streamNewOrigin,
    });
    store.getState().newDraft();
    store.getState().setImages([{ data: 'image', mimeType: 'image/png' }]);

    await store.getState().send();

    expect(streamNewOrigin).toHaveBeenCalledWith(
      expect.objectContaining({
        materializationId: 'draft-image',
        message: '',
        images: [{ data: 'image', mimeType: 'image/png' }],
      }),
      expect.any(Function),
      expect.any(Function),
    );
  });

  it('canonicalizes remembered config before a programmatic first send', async () => {
    const remembered = config({ provider: 'removed', model: 'removed-model', reasoningEffort: 'ultra' });
    const canonical = config({ provider: 'codex', model: 'gpt-5.4', reasoningEffort: 'high' });
    const canonicalizeConfig = vi.fn(async () => canonical);
    const streamNewOrigin = vi.fn(async (_input, onMaterialized) => {
      onMaterialized('origin-canonical');
      return { kind: 'streamed' as const };
    });
    const prefs = preferences({ lastConfig: remembered });
    const store = createOriginStore({
      preferences: prefs,
      canonicalizeConfig,
      createMaterializationId: () => 'draft-canonical',
      streamNewOrigin,
    });
    store.getState().newDraft();
    store.getState().setMessage('run with a valid snapshot');

    await store.getState().send();

    expect(canonicalizeConfig).toHaveBeenCalledWith(remembered);
    expect(streamNewOrigin).toHaveBeenCalledWith(
      expect.objectContaining({ config: canonical }),
      expect.any(Function),
      expect.any(Function),
    );
    expect(prefs.load().lastConfig).toEqual(canonical);
  });

  it('atomically replaces the current draft when the materialization header arrives', async () => {
    const prefs = preferences();
    let store!: ReturnType<typeof createOriginStore>;
    let stateBeforeFirstEvent: ReturnType<typeof store.getState> | null = null;
    const streamNewOrigin = vi.fn(async (_input, onMaterialized, onEvent) => {
      onMaterialized('origin-new');
      stateBeforeFirstEvent = store.getState();
      onEvent({
        sessionId: 'origin-new', runId: 'run-1', seq: 1,
        event: { type: 'agent_end', error: null },
      });
      return { kind: 'streamed' as const };
    });
    store = createOriginStore({
      preferences: prefs,
      createMaterializationId: () => 'draft-new',
      streamNewOrigin,
      now: () => new Date('2026-07-26T01:00:00.000Z'),
    });
    store.getState().newDraft(config({ provider: 'codex', model: 'gpt-5.4' }));
    store.getState().setMessage('hello');

    await store.getState().send();

    expect(stateBeforeFirstEvent!.selection).toEqual({ kind: 'session', sessionId: 'origin-new' });
    expect(stateBeforeFirstEvent!.sessionById['origin-new'].messages[0]).toMatchObject({
      sessionId: 'origin-new', role: 'user', content: 'hello',
    });
    expect(prefs.load()).toEqual({
      lastConfig: config({ provider: 'codex', model: 'gpt-5.4' }),
      lastOpenedSessionId: 'origin-new',
    });
    expect(store.getState().runningIds.has('origin-new')).toBe(false);
  });

  it('reconciles a retry conflict using the same materialization id', async () => {
    const attempts: StartOriginInput[] = [];
    const existing = sessionResponse('origin-existing', { provider: 'codex', model: 'gpt-5.4' });
    const history = { sessions: [summary('origin-existing')] };
    const streamNewOrigin = vi.fn(async (input) => {
      attempts.push(input);
      if (attempts.length === 1) throw new Error('connection lost');
      return { kind: 'already-materialized' as const, sessionId: 'origin-existing' };
    });
    const fetchOrigin = vi.fn(async () => existing);
    const fetchOrigins = vi.fn(async () => history);
    const store = createOriginStore({
      preferences: preferences(),
      createMaterializationId: () => 'stable-materialization-id',
      streamNewOrigin,
      fetchOrigin,
      fetchOrigins,
    });
    store.getState().newDraft();
    store.getState().setMessage('run once');

    await store.getState().send();
    await store.getState().send();

    expect(attempts.map((attempt) => attempt.materializationId)).toEqual([
      'stable-materialization-id',
      'stable-materialization-id',
    ]);
    expect(fetchOrigin).toHaveBeenCalledWith('origin-existing');
    expect(fetchOrigins).toHaveBeenCalledOnce();
    expect(store.getState().selection).toEqual({ kind: 'session', sessionId: 'origin-existing' });
    expect(store.getState().sessionById['origin-existing']).toMatchObject(existing);
    expect(store.getState().sessionById['origin-existing'].run).toMatchObject({ status: 'idle' });
    expect(store.getState().origins).toHaveLength(1);
    expect(store.getState().origins[0]).toMatchObject({ id: 'origin-existing', run: { status: 'idle' } });
  });

  it('keeps a conflicted server run authoritative until reconciliation settles it', async () => {
    const refresh = deferred<void>();
    const running = sessionRun('origin-existing', 'running', 'run-server');
    const idle = sessionRun('origin-existing', 'idle', 'run-server');
    const responses = [
      { ...sessionResponse('origin-existing'), run: running },
      { ...sessionResponse('origin-existing'), run: idle },
    ];
    const store = createOriginStore({
      preferences: preferences(),
      createMaterializationId: () => 'draft-conflict',
      streamNewOrigin: vi.fn(async () => ({
        kind: 'already-materialized' as const,
        sessionId: 'origin-existing',
      })),
      fetchOrigin: vi.fn(async () => responses.shift()!),
      fetchOriginRun: vi.fn(async () => ({ run: idle })),
      fetchOrigins: vi.fn(async () => ({ sessions: [{ ...summary('origin-existing'), run: running }] })),
      waitForRunRefresh: () => refresh.promise,
    });
    store.getState().newDraft();
    store.getState().setMessage('reconcile me');

    await store.getState().send();

    expect(store.getState().runBySessionId['origin-existing']).toEqual(running);
    expect(store.getState().runningIds).toEqual(new Set(['origin-existing']));
    refresh.resolve();
    await vi.waitFor(() => expect(store.getState().runningIds.has('origin-existing')).toBe(false));
    expect(store.getState().runBySessionId['origin-existing']).toEqual(idle);
  });

  it('does not let stale conflict recovery overwrite a newer local run', async () => {
    const conflictDetail = deferred<OriginSessionResponse>();
    const localStream = deferred<void>();
    const fetchOrigin = vi.fn(() => conflictDetail.promise);
    const store = createOriginStore({
      preferences: preferences(),
      createMaterializationId: () => 'draft-conflict-race',
      streamNewOrigin: vi.fn(async () => ({
        kind: 'already-materialized' as const,
        sessionId: 'origin-existing',
      })),
      fetchOrigin,
      fetchOrigins: vi.fn(async () => ({ sessions: [summary('origin-existing')] })),
      streamOriginMessage: vi.fn(() => localStream.promise),
    });
    store.getState().newDraft();
    store.getState().setMessage('recover old run');
    const recovering = store.getState().send();
    await vi.waitFor(() => expect(fetchOrigin).toHaveBeenCalledOnce());

    store.setState({
      selection: { kind: 'session', sessionId: 'origin-existing' },
      sessionById: { 'origin-existing': sessionResponse('origin-existing') },
    });
    store.getState().setMessage('new local run');
    const sending = store.getState().send();
    await vi.waitFor(() => expect(store.getState().runningIds.has('origin-existing')).toBe(true));
    conflictDetail.resolve({
      ...sessionResponse('origin-existing'),
      run: sessionRun('origin-existing', 'idle'),
    });
    await recovering;

    expect(store.getState().runningIds.has('origin-existing')).toBe(true);
    localStream.resolve();
    await sending;
  });

  it('does not let a late draft materialization clear a newer selection error or preferences', async () => {
    const stream = deferred<void>();
    const prefs = preferences();
    let materialize: ((sessionId: string) => void) | null = null;
    const store = createOriginStore({
      preferences: prefs,
      createMaterializationId: () => 'draft-late',
      fetchOrigin: async () => { throw new Error('newer selection failed'); },
      streamNewOrigin: vi.fn(async (_input, onMaterialized) => {
        materialize = onMaterialized;
        await stream.promise;
        return { kind: 'streamed' as const };
      }),
    });
    store.getState().newDraft(config({ provider: 'codex', model: 'gpt-5.4' }));
    store.getState().setMessage('hello');

    const sending = store.getState().send();
    await vi.waitFor(() => expect(materialize).not.toBeNull());
    await store.getState().select('origin-newer');
    expect(store.getState().error).toBe('newer selection failed');

    materialize!('origin-late');

    expect(store.getState().selection).toEqual({ kind: 'session', sessionId: 'origin-newer' });
    expect(store.getState().error).toBe('newer selection failed');
    expect(prefs.load()).toEqual({ lastConfig: null, lastOpenedSessionId: 'origin-newer' });
    stream.resolve();
    await sending;
  });

  it('restores only a last-opened Session that still exists in history', async () => {
    const remembered = preferences({ lastOpenedSessionId: 'origin-valid' });
    const restored: string[] = [];
    const store = createOriginStore({
      preferences: remembered,
      fetchOrigins: async () => ({ sessions: [summary('origin-valid')] }),
      fetchOrigin: async () => sessionResponse('origin-valid'),
    });

    store.getState().init((id) => restored.push(id));
    await vi.waitFor(() => expect(store.getState().loading).toBe(false));

    expect(restored).toEqual(['origin-valid']);
    expect(store.getState().selection).toEqual({ kind: 'session', sessionId: 'origin-valid' });
    expect(store.getState().sessionById['origin-valid'].session?.id).toBe('origin-valid');
  });

  it('clears stale restored identity without creating a draft', async () => {
    const remembered = preferences({ lastOpenedSessionId: 'origin-missing' });
    const fetchOrigin = vi.fn();
    const store = createOriginStore({
      preferences: remembered,
      fetchOrigins: async () => ({ sessions: [] }),
      fetchOrigin,
    });

    store.getState().init();
    await vi.waitFor(() => expect(store.getState().loading).toBe(false));

    expect(store.getState().selection).toBeNull();
    expect(remembered.load().lastOpenedSessionId).toBeNull();
    expect(fetchOrigin).not.toHaveBeenCalled();
  });

  it('lets a superseded init refresh history without restoring selection or changing preferences', async () => {
    const history = deferred<OriginSessionHistoryResponse>();
    const prefs = preferences({ lastOpenedSessionId: 'origin-stale' });
    const store = createOriginStore({
      preferences: prefs,
      createMaterializationId: () => 'draft-current',
      fetchOrigins: () => history.promise,
    });

    store.getState().init();
    store.getState().newDraft();
    history.resolve({ sessions: [summary('origin-server')] });
    await vi.waitFor(() => expect(store.getState().origins).toHaveLength(1));

    expect(store.getState().selection).toMatchObject({
      kind: 'draft', draft: { materializationId: 'draft-current' },
    });
    expect(store.getState().loading).toBe(false);
    expect(store.getState().error).toBeNull();
    expect(prefs.load().lastOpenedSessionId).toBe('origin-stale');
  });
});

describe('Origin store persisted Session composer', () => {
  it('hydrates running state from Session history before any local stream starts', async () => {
    const running = {
      sessionId: 'origin-running',
      runId: 'run-server',
      status: 'running' as const,
      activeFlags: [],
      lastSeq: 4,
      error: null,
    };
    const historyItem = { ...summary('origin-running'), run: running };
    const deleteOrigin = vi.fn();
    const store = createOriginStore({
      preferences: preferences(),
      fetchOrigins: async () => ({ sessions: [historyItem] }),
      deleteOrigin,
    });

    store.getState().init();
    await vi.waitFor(() => expect(store.getState().loading).toBe(false));

    expect(store.getState().runBySessionId['origin-running']).toEqual(running);
    expect(store.getState().runningIds.has('origin-running')).toBe(true);
    await expect(store.getState().remove('origin-running')).resolves.toBe(false);
    expect(deleteOrigin).not.toHaveBeenCalled();
  });

  it('projects a newer detail run through history, detail, and compatibility views', async () => {
    const running = {
      sessionId: 'origin-1',
      runId: 'run-detail',
      status: 'running' as const,
      activeFlags: [],
      lastSeq: 3,
      error: null,
    };
    const detail = { ...sessionResponse('origin-1'), run: running };
    const store = createOriginStore({
      preferences: preferences(),
      fetchOrigins: async () => ({ sessions: [summary('origin-1')] }),
      fetchOrigin: async () => detail,
    });

    store.getState().init();
    await vi.waitFor(() => expect(store.getState().loading).toBe(false));
    await store.getState().select('origin-1');

    expect(store.getState().runBySessionId['origin-1']).toEqual(running);
    expect(store.getState().origins[0]?.run).toEqual(running);
    expect(store.getState().sessionById['origin-1']?.run).toEqual(running);
    expect(store.getState().runningIds).toEqual(new Set(['origin-1']));
  });

  it('lets stale Session loads populate cache without taking active request state or preferences', async () => {
    const first = deferred<OriginSessionResponse>();
    const second = deferred<OriginSessionResponse>();
    const prefs = preferences();
    const store = createOriginStore({
      preferences: prefs,
      fetchOrigin: (sessionId) => sessionId === 'origin-a' ? first.promise : second.promise,
    });

    const selectingFirst = store.getState().select('origin-a');
    const selectingSecond = store.getState().select('origin-b');
    first.resolve(sessionResponse('origin-a', { provider: 'openai', model: 'gpt-a' }));
    await selectingFirst;

    expect(store.getState().sessionById['origin-a'].session?.id).toBe('origin-a');
    expect(store.getState().selection).toEqual({ kind: 'session', sessionId: 'origin-b' });
    expect(store.getState().loading).toBe(true);
    expect(store.getState().error).toBeNull();
    expect(prefs.load()).toEqual({ lastConfig: null, lastOpenedSessionId: 'origin-b' });

    second.resolve(sessionResponse('origin-b', { provider: 'anthropic', model: 'claude-b' }));
    await selectingSecond;

    expect(store.getState().loading).toBe(false);
    expect(prefs.load()).toEqual({
      lastConfig: config({ provider: 'anthropic', model: 'claude-b' }),
      lastOpenedSessionId: 'origin-b',
    });
  });

  it('rejects an older detail response for the same Session', async () => {
    const older = deferred<OriginSessionResponse>();
    const newer = deferred<OriginSessionResponse>();
    const responses = [older, newer];
    const store = createOriginStore({
      preferences: preferences(),
      fetchOrigin: vi.fn(() => responses.shift()!.promise),
    });

    const first = store.getState().select('origin-a');
    const second = store.getState().select('origin-a');
    const running = sessionRun('origin-a', 'running', 'run-newer');
    newer.resolve({ ...sessionResponse('origin-a'), run: running });
    await second;
    older.resolve({ ...sessionResponse('origin-a'), run: sessionRun('origin-a', 'idle') });
    await first;

    expect(store.getState().runBySessionId['origin-a']).toEqual(running);
    expect(store.getState().runningIds).toEqual(new Set(['origin-a']));
  });

  it('reconciles a detached running Session restored from history', async () => {
    const refresh = deferred<void>();
    const running = sessionRun('origin-detached', 'running', 'run-detached');
    const store = createOriginStore({
      preferences: preferences(),
      fetchOrigins: async () => ({ sessions: [{ ...summary('origin-detached'), run: running }] }),
      fetchOrigin: async () => ({
        ...sessionResponse('origin-detached'),
        run: sessionRun('origin-detached', 'idle', 'run-detached'),
      }),
      fetchOriginRun: async () => ({ run: sessionRun('origin-detached', 'idle', 'run-detached') }),
      waitForRunRefresh: () => refresh.promise,
    });

    store.getState().init();
    await vi.waitFor(() => expect(store.getState().runningIds.has('origin-detached')).toBe(true));
    refresh.resolve();
    await vi.waitFor(() => expect(store.getState().runningIds.has('origin-detached')).toBe(false));
  });

  it('keeps polling when full detail observes a run started after an idle status read', async () => {
    const firstRefresh = deferred<void>();
    const secondRefresh = deferred<void>();
    const refreshes = [firstRefresh, secondRefresh];
    const running = sessionRun('origin-cross-tab', 'running', 'run-new');
    const idle = sessionRun('origin-cross-tab', 'idle', 'run-new');
    const details = [
      { ...sessionResponse('origin-cross-tab'), run: running },
      { ...sessionResponse('origin-cross-tab'), run: idle },
    ];
    const fetchOrigin = vi.fn(async () => details.shift()!);
    const fetchOriginRun = vi.fn(async () => ({ run: idle }));
    const store = createOriginStore({
      preferences: preferences(),
      fetchOrigins: async () => ({
        sessions: [{ ...summary('origin-cross-tab'), run: sessionRun('origin-cross-tab', 'running', 'run-old') }],
      }),
      fetchOrigin,
      fetchOriginRun,
      waitForRunRefresh: () => refreshes.shift()!.promise,
    });

    store.getState().init();
    firstRefresh.resolve();
    await vi.waitFor(() => expect(fetchOrigin).toHaveBeenCalledOnce());
    expect(store.getState().runBySessionId['origin-cross-tab']).toEqual(running);

    secondRefresh.resolve();
    await vi.waitFor(() => expect(store.getState().runningIds.has('origin-cross-tab')).toBe(false));
    expect(fetchOriginRun).toHaveBeenCalledTimes(2);
    expect(fetchOrigin).toHaveBeenCalledTimes(2);
  });

  it('refreshes server run state immediately after Stop is accepted', async () => {
    const stopOrigin = vi.fn(async () => undefined);
    const store = createOriginStore({
      preferences: preferences(),
      stopOrigin,
      fetchOrigin: async () => ({
        ...sessionResponse('origin-stop'),
        run: sessionRun('origin-stop', 'idle', 'run-stop'),
      }),
      fetchOriginRun: async () => ({ run: sessionRun('origin-stop', 'idle', 'run-stop') }),
      waitForRunRefresh: async () => undefined,
    });
    store.setState({
      selection: { kind: 'session', sessionId: 'origin-stop' },
      sessionById: { 'origin-stop': sessionResponse('origin-stop') },
      runBySessionId: { 'origin-stop': sessionRun('origin-stop', 'running', 'run-stop') },
      runningIds: new Set(['origin-stop']),
    });

    await store.getState().stop('origin-stop');

    expect(stopOrigin).toHaveBeenCalledWith('origin-stop');
    await vi.waitFor(() => expect(store.getState().runningIds.has('origin-stop')).toBe(false));
  });

  it('reconciles Stop after a local preflight request fails', async () => {
    const stream = deferred<void>();
    const store = createOriginStore({
      preferences: preferences(),
      streamOriginMessage: vi.fn(() => stream.promise),
      stopOrigin: vi.fn(async () => undefined),
      fetchOrigin: async () => ({
        ...sessionResponse('origin-preflight'),
        run: sessionRun('origin-preflight', 'idle', 'run-preflight'),
      }),
      fetchOriginRun: async () => ({ run: sessionRun('origin-preflight', 'idle', 'run-preflight') }),
      waitForRunRefresh: async () => undefined,
    });
    store.setState({
      selection: { kind: 'session', sessionId: 'origin-preflight' },
      sessionById: { 'origin-preflight': sessionResponse('origin-preflight') },
    });
    store.getState().setMessage('start slowly');

    const sending = store.getState().send();
    await vi.waitFor(() => expect(store.getState().runningIds.has('origin-preflight')).toBe(true));
    await store.getState().stop('origin-preflight');
    stream.reject(new Error('Origin request failed: aborted during preflight'));
    await sending;

    await vi.waitFor(() => expect(store.getState().runningIds.has('origin-preflight')).toBe(false));
    expect(store.getState().error).toBeNull();
  });

  it('does not let a stale deletion failure own a newer cached selection', async () => {
    const deletion = deferred<{ history: OriginSessionHistoryResponse }>();
    const prefs = preferences({ lastOpenedSessionId: 'origin-a' });
    const store = createOriginStore({
      preferences: prefs,
      deleteOrigin: () => deletion.promise,
    });
    store.setState({
      selection: { kind: 'session', sessionId: 'origin-a' },
      sessionById: {
        'origin-a': sessionResponse('origin-a'),
        'origin-b': sessionResponse('origin-b'),
      },
    });

    const removing = store.getState().remove('origin-a');
    await store.getState().select('origin-b');
    deletion.reject(new Error('delete failed late'));
    await expect(removing).resolves.toBe(false);

    expect(store.getState().selection).toEqual({ kind: 'session', sessionId: 'origin-b' });
    expect(store.getState().loading).toBe(false);
    expect(store.getState().error).toBeNull();
    expect(prefs.load().lastOpenedSessionId).toBe('origin-b');
  });

  it('sends and clears per-Session text, images, and skills together', async () => {
    const streamOriginMessage = vi.fn(async () => {});
    const store = createOriginStore({
      preferences: preferences(),
      streamOriginMessage,
    });
    store.setState({
      selection: { kind: 'session', sessionId: 'origin-1' },
      sessionById: { 'origin-1': sessionResponse('origin-1') },
    });
    store.getState().setMessage('follow up');
    store.getState().setImages([{ data: 'image', mimeType: 'image/png' }]);
    store.getState().setSkillNames(['codebase-design', 'codebase-design']);

    await store.getState().send();

    expect(streamOriginMessage).toHaveBeenCalledWith(
      'origin-1',
      'follow up',
      {
        images: [{ data: 'image', mimeType: 'image/png' }],
        skillNames: ['codebase-design'],
      },
      expect.any(Function),
    );
    expect(store.getState().composerBySessionId['origin-1']).toEqual({
      message: '', images: [], skillNames: [],
    });
  });

  it('projects live tool calls while the run streams and drops them when it ends', async () => {
    const seen: Array<{ callId: string; output: string | null }> = [];
    const streamOriginMessage = vi.fn(async (
      _sessionId: string,
      _message: string,
      _options: unknown,
      onEvent: (event: OriginStreamEvent) => void,
    ) => {
      const toolCall = { id: 'call-1', name: 'shell', arguments: { command: 'pwd' } };
      onEvent({
        sessionId: 'origin-1', runId: 'run-1', seq: 1,
        event: { type: 'tool_execution_start', toolCall },
      });
      seen.push(...store.getState().toolActivityById['origin-1']);
      onEvent({
        sessionId: 'origin-1', runId: 'run-1', seq: 2,
        event: {
          type: 'tool_execution_end',
          toolCall: { id: 'call-1', name: 'shell', arguments: {} },
          toolResult: { callId: 'call-1', name: 'shell', output: '/tmp/session', error: false },
        },
      });
      seen.push(...store.getState().toolActivityById['origin-1']);
    });
    const store = createOriginStore({ preferences: preferences(), streamOriginMessage });
    store.setState({
      selection: { kind: 'session', sessionId: 'origin-1' },
      sessionById: { 'origin-1': sessionResponse('origin-1') },
    });
    store.getState().setMessage('what is the working directory');

    await store.getState().send();

    // The end event carries no arguments, so the ones seen at start must survive.
    expect(seen).toEqual([
      { callId: 'call-1', name: 'shell', arguments: { command: 'pwd' }, output: null, isError: false },
      { callId: 'call-1', name: 'shell', arguments: { command: 'pwd' }, output: '/tmp/session', isError: false },
    ]);
    expect(store.getState().toolActivityById['origin-1']).toBeUndefined();
  });

  it('rolls back a cross-tab 409 and reconciles the authoritative run', async () => {
    const refresh = deferred<void>();
    const fetchOriginRun = vi.fn(async () => ({
      run: sessionRun('origin-conflict', 'running', 'run-other-tab'),
    }));
    const store = createOriginStore({
      preferences: preferences(),
      streamOriginMessage: vi.fn(async () => {
        throw new HttpResponseError(409, 'agent stream failed: a Runtime run is already active');
      }),
      fetchOriginRun,
      waitForRunRefresh: () => refresh.promise,
    });
    store.setState({
      selection: { kind: 'session', sessionId: 'origin-conflict' },
      sessionById: { 'origin-conflict': sessionResponse('origin-conflict') },
    });
    store.getState().setMessage('keep this prompt');
    store.getState().setImages([{ data: 'image', mimeType: 'image/png' }]);
    store.getState().setSkillNames(['codebase-design']);

    await store.getState().send();

    expect(store.getState().composerBySessionId['origin-conflict']).toEqual({
      message: 'keep this prompt',
      images: [{ data: 'image', mimeType: 'image/png' }],
      skillNames: ['codebase-design'],
    });
    expect(store.getState().sessionById['origin-conflict'].messages).toEqual([]);
    await vi.waitFor(() => expect(fetchOriginRun).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(store.getState().runBySessionId['origin-conflict']).toMatchObject({
      status: 'running',
      runId: 'run-other-tab',
    }));
    expect(store.getState().error).toBeNull();
  });

  it('merges newer composer input when a rejected send resolves late', async () => {
    const rejection = deferred<void>();
    const store = createOriginStore({
      preferences: preferences(),
      streamOriginMessage: vi.fn(() => rejection.promise),
    });
    store.setState({
      selection: { kind: 'session', sessionId: 'origin-late-rejection' },
      sessionById: { 'origin-late-rejection': sessionResponse('origin-late-rejection') },
    });
    store.getState().setMessage('first prompt');
    store.getState().setSkillNames(['first-skill']);

    const sending = store.getState().send();
    await vi.waitFor(() => expect(store.getState().runningIds.has('origin-late-rejection')).toBe(true));
    store.getState().setMessage('newer prompt');
    store.getState().setSkillNames(['newer-skill']);
    rejection.reject(new HttpResponseError(409, 'agent stream failed: already active'));
    await sending;

    expect(store.getState().composerBySessionId['origin-late-rejection']).toEqual({
      message: 'first prompt\n\nnewer prompt',
      images: [],
      skillNames: ['first-skill', 'newer-skill'],
    });
    expect(store.getState().sessionById['origin-late-rejection'].messages).toEqual([]);
  });

  it('advances a local run only from matching ordered stream envelopes', async () => {
    const stream = deferred<void>();
    let emit: ((event: OriginStreamEvent) => void) | null = null;
    const store = createOriginStore({
      preferences: preferences(),
      streamOriginMessage: vi.fn(async (_sessionId, _message, _options, onEvent) => {
        emit = onEvent;
        await stream.promise;
      }),
    });
    store.setState({
      selection: { kind: 'session', sessionId: 'origin-1' },
      sessionById: { 'origin-1': sessionResponse('origin-1') },
    });
    store.getState().setMessage('follow up');

    const sending = store.getState().send();
    await vi.waitFor(() => expect(emit).not.toBeNull());

    emit!({ sessionId: 'origin-1', runId: 'run-current', seq: 1, event: { type: 'agent_start' } });
    expect(store.getState().runBySessionId['origin-1']).toMatchObject({
      runId: 'run-current', status: 'running', lastSeq: 1,
    });

    const otherRunning = {
      sessionId: 'origin-other', runId: 'run-other', status: 'running' as const,
      activeFlags: [], lastSeq: 5, error: null,
    };
    emit!({
      sessionId: 'origin-1', runId: 'run-current', seq: 2,
      event: {
        type: 'session_update',
        session: sessionResponse('origin-1'),
        history: { sessions: [{ ...summary('origin-other'), run: otherRunning }] },
      },
    });
    expect(store.getState().runBySessionId['origin-other']).toEqual(otherRunning);
    expect(store.getState().runningIds).toEqual(new Set(['origin-1', 'origin-other']));

    emit!({
      sessionId: 'origin-1', runId: 'run-stale', seq: 99,
      event: { type: 'agent_end', error: null },
    });
    emit!({
      sessionId: 'origin-other', runId: 'run-current', seq: 3,
      event: { type: 'agent_end', error: null },
    });
    expect(store.getState().runBySessionId['origin-1']).toMatchObject({
      runId: 'run-current', status: 'running', lastSeq: 2,
    });

    emit!({
      sessionId: 'origin-1', runId: 'run-current', seq: 3,
      event: { type: 'agent_end', error: null },
    });
    expect(store.getState().runBySessionId['origin-1']).toMatchObject({
      runId: 'run-current', status: 'idle', lastSeq: 3,
    });
    stream.resolve();
    await sending;
  });

  it('keeps a background stream failure on its own Session after selection changes', async () => {
    const stream = deferred<void>();
    const store = createOriginStore({
      preferences: preferences(),
      streamOriginMessage: vi.fn(async () => {
        await stream.promise;
      }),
    });
    store.setState({
      selection: { kind: 'session', sessionId: 'origin-a' },
      sessionById: {
        'origin-a': sessionResponse('origin-a'),
        'origin-b': sessionResponse('origin-b'),
      },
    });
    store.getState().setMessage('follow up');

    const sending = store.getState().send();
    await vi.waitFor(() => expect(store.getState().runningIds.has('origin-a')).toBe(true));
    await store.getState().select('origin-b');
    stream.reject(new Error('origin-a disconnected'));
    await sending;

    expect(store.getState().selection).toEqual({ kind: 'session', sessionId: 'origin-b' });
    expect(store.getState().error).toBeNull();
    expect(store.getState().runBySessionId['origin-a']).toMatchObject({
      status: 'error', error: 'origin-a disconnected',
    });
    expect(store.getState().runningIds.has('origin-a')).toBe(false);
  });

  it('projects an explicitly aborted run as idle instead of an error', async () => {
    let emit: ((event: OriginStreamEvent) => void) | null = null;
    const store = createOriginStore({
      preferences: preferences(),
      streamOriginMessage: vi.fn(async (_sessionId, _message, _options, onEvent) => {
        emit = onEvent;
        onEvent({
          sessionId: 'origin-1', runId: 'run-aborted', seq: 1,
          event: { type: 'agent_end', error: 'Pi run was aborted', errorCode: 'aborted' },
        });
      }),
    });
    store.setState({
      selection: { kind: 'session', sessionId: 'origin-1' },
      sessionById: { 'origin-1': sessionResponse('origin-1') },
    });
    store.getState().setMessage('stop this');

    await store.getState().send();

    expect(emit).not.toBeNull();
    expect(store.getState().runBySessionId['origin-1']).toMatchObject({
      runId: 'run-aborted', status: 'idle', error: null,
    });
    expect(store.getState().error).toBeNull();
  });

  it('invalidates model and reasoning when its runtime or provider changes', () => {
    const store = createOriginStore({
      preferences: preferences({
        lastConfig: config({ provider: 'codex', model: 'gpt-5.4', reasoningEffort: 'high' }),
      }),
      createMaterializationId: () => 'draft-config',
    });
    store.getState().newDraft();

    store.getState().updateDraft({ config: { provider: 'anthropic' } });
    expect(store.getState().selection).toMatchObject({
      kind: 'draft',
      draft: { config: { runtime: 'pi', provider: 'anthropic', model: null, reasoningEffort: null } },
    });

    store.getState().updateDraft({ config: { runtime: 'cursor', model: 'auto' } });
    expect(store.getState().selection).toMatchObject({
      kind: 'draft',
      draft: { config: { runtime: 'cursor', provider: null, model: 'auto', reasoningEffort: null } },
    });
  });

  it('does not carry remembered provider, model, or effort through a partial runtime override', () => {
    const store = createOriginStore({
      preferences: preferences({
        lastConfig: config({ provider: 'codex', model: 'gpt-5.4', reasoningEffort: 'high' }),
      }),
      createMaterializationId: () => 'draft-runtime-override',
    });

    const draft = store.getState().newDraft({ runtime: 'cursor' });

    expect(draft.config).toEqual({
      runtime: 'cursor', provider: null, model: null, reasoningEffort: null,
    });
  });
});

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
