/** Origin workspace state: ephemeral drafts, persisted Sessions, and Runtime streams. */
import { create, type StoreApi } from 'zustand';
import {
  deleteOrigin as deleteOriginRequest,
  fetchOrigin as fetchOriginRequest,
  fetchOriginRun as fetchOriginRunRequest,
  fetchOrigins as fetchOriginsRequest,
  stopOrigin as stopOriginRequest,
  streamNewOrigin as streamNewOriginRequest,
  streamOriginMessage as streamOriginMessageRequest,
} from '../api';
import type {
  AgentMessage,
  AgentSessionRun,
  ImageAttachment,
  OriginDraft,
  OriginDraftConfig,
  OriginSelection,
  OriginSessionHistoryResponse,
  OriginSessionResponse,
  OriginSessionSummary,
  OriginStreamEvent,
  StartOriginInput,
  StartOriginStreamResult,
} from '../types';
import { transitionOriginConfig } from '../chat/originCatalog';
import { limitOriginImages } from '../chat/originImages';
import { HttpResponseError } from '../api/http';
import { canonicalizeAvailableOriginConfig } from './origin/catalog';
import {
  DEFAULT_ORIGIN_CONFIG,
  originPreferences,
  type OriginPreferencesAdapter,
} from './origin/preferences';

export interface OriginComposerDraft {
  message: string;
  images: ImageAttachment[];
  skillNames: string[];
}

export interface OriginDraftPatch {
  config?: Partial<OriginDraftConfig>;
  message?: string;
  images?: ImageAttachment[];
  skillNames?: string[];
}

export interface OriginState {
  origins: OriginSessionSummary[];
  sessionById: Record<string, OriginSessionResponse>;
  selection: OriginSelection | null;
  composerBySessionId: Record<string, OriginComposerDraft>;
  streamingById: Record<string, string>;
  runBySessionId: Record<string, AgentSessionRun>;
  /** Compatibility projection for existing views; derived from runBySessionId. */
  runningIds: Set<string>;
  loading: boolean;
  error: string | null;
  init: (onRestored?: (sessionId: string) => void) => () => void;
  newDraft: (config?: Partial<OriginDraftConfig>) => OriginDraft;
  updateDraft: (patch: OriginDraftPatch) => void;
  setMessage: (value: string) => void;
  setImages: (images: ImageAttachment[]) => void;
  setSkillNames: (skillNames: string[]) => void;
  select: (sessionId: string) => Promise<void>;
  remove: (sessionId: string) => Promise<boolean>;
  stop: (sessionId: string) => Promise<void>;
  send: () => Promise<void>;
}

interface OriginStoreDependencies {
  fetchOrigins: () => Promise<OriginSessionHistoryResponse>;
  fetchOrigin: (sessionId: string) => Promise<OriginSessionResponse>;
  fetchOriginRun: (sessionId: string) => Promise<{ run: AgentSessionRun }>;
  deleteOrigin: (sessionId: string) => Promise<{ history: OriginSessionHistoryResponse }>;
  stopOrigin: (sessionId: string) => Promise<void>;
  streamNewOrigin: (
    input: StartOriginInput,
    onMaterialized: (sessionId: string) => void,
    onEvent: (event: OriginStreamEvent) => void,
  ) => Promise<StartOriginStreamResult>;
  streamOriginMessage: (
    sessionId: string,
    message: string,
    options: { images?: ImageAttachment[]; skillNames?: string[] } | undefined,
    onEvent: (event: OriginStreamEvent) => void,
  ) => Promise<void>;
  preferences: OriginPreferencesAdapter;
  canonicalizeConfig: (config: OriginDraftConfig) => Promise<OriginDraftConfig>;
  waitForRunRefresh: (() => Promise<void>) | null;
  createMaterializationId: () => string;
  now: () => Date;
}

interface OriginRunOwners {
  next: number;
  bySessionId: Map<string, number>;
}

interface OriginRequestOwners {
  next: number;
  active: number | null;
  bySessionId: Map<string, number>;
}

interface OriginReconcileOwners {
  next: number;
  bySessionId: Map<string, number>;
  afterLocalRun: Set<string>;
}

const DEFAULT_DEPENDENCIES: OriginStoreDependencies = {
  fetchOrigins: fetchOriginsRequest,
  fetchOrigin: fetchOriginRequest,
  fetchOriginRun: fetchOriginRunRequest,
  deleteOrigin: deleteOriginRequest,
  stopOrigin: stopOriginRequest,
  streamNewOrigin: streamNewOriginRequest,
  streamOriginMessage: streamOriginMessageRequest,
  preferences: originPreferences,
  canonicalizeConfig: async (config) => ({ ...config }),
  waitForRunRefresh: null,
  createMaterializationId: randomId,
  now: () => new Date(),
};

let optimisticId = 0;

/** Creates the production hook or an injected in-memory Adapter for behavior tests. */
export function createOriginStore(overrides: Partial<OriginStoreDependencies> = {}) {
  const dependencies = { ...DEFAULT_DEPENDENCIES, ...overrides };
  const runOwners: OriginRunOwners = { next: 0, bySessionId: new Map() };
  const requestOwners: OriginRequestOwners = { next: 0, active: null, bySessionId: new Map() };
  const reconcileOwners: OriginReconcileOwners = {
    next: 0,
    bySessionId: new Map(),
    afterLocalRun: new Set(),
  };

  return create<OriginState>((set, get) => ({
    origins: [],
    sessionById: {},
    selection: null,
    composerBySessionId: {},
    streamingById: {},
    runBySessionId: {},
    runningIds: new Set(),
    loading: false,
    error: null,

    init: (onRestored) => {
      let disposed = false;
      const requestOwner = claimRequest(requestOwners);
      set({ loading: true, error: null });
      void dependencies.fetchOrigins()
        .then(async (payload) => {
          if (disposed) return;
          const ownsStatus = ownsRequest(requestOwners, requestOwner);
          const rememberedId = dependencies.preferences.load().lastOpenedSessionId;
          const restoredId = rememberedId && payload.sessions.some((item) => item.id === rememberedId)
            ? rememberedId
            : null;
          if (ownsStatus && rememberedId && !restoredId) {
            dependencies.preferences.saveLastOpenedSessionId(null);
          }

          const shouldRestore = Boolean(ownsStatus && restoredId && get().selection === null);
          set((state) => hydrateHistoryRuns(state, payload.sessions, {
            origins: payload.sessions,
            selection: shouldRestore && restoredId
              ? { kind: 'session', sessionId: restoredId }
              : state.selection,
          }, runOwners.bySessionId));
          reconcileRunningSummaries({
            dependencies, get, set, runOwners, reconcileOwners, summaries: payload.sessions,
          });
          if (!shouldRestore || !restoredId) return;
          onRestored?.(restoredId);
          const sessionOwner = claimSessionRequest(requestOwners, restoredId);
          try {
            const session = await dependencies.fetchOrigin(restoredId);
            if (!disposed && ownsSessionRequest(requestOwners, restoredId, sessionOwner)) {
              set((state) => hydrateSessionRun(state, restoredId, session, runOwners.bySessionId));
              reconcileServerRun({ dependencies, get, set, runOwners, reconcileOwners, sessionId: restoredId });
            }
          } finally {
            releaseSessionRequest(requestOwners, restoredId, sessionOwner);
          }
        })
        .catch((error) => {
          if (!disposed && ownsRequest(requestOwners, requestOwner)) {
            set({ error: errorMessage(error) });
          }
        })
        .finally(() => {
          if (!disposed && releaseRequest(requestOwners, requestOwner)) set({ loading: false });
        });
      return () => {
        disposed = true;
        releaseRequest(requestOwners, requestOwner);
        cancelAllReconciliations(reconcileOwners);
      };
    },

    newDraft: (config = {}) => {
      supersedeRequest(requestOwners);
      const remembered = dependencies.preferences.load().lastConfig ?? DEFAULT_ORIGIN_CONFIG;
      const draft: OriginDraft = {
        materializationId: dependencies.createMaterializationId(),
        config: transitionOriginConfig(remembered, config),
        message: '',
        images: [],
        skillNames: [],
        phase: 'editing',
      };
      set({ selection: { kind: 'draft', draft }, loading: false, error: null });
      return draft;
    },

    updateDraft: (patch) => set((state) => {
      const selection = state.selection;
      if (selection?.kind !== 'draft' || selection.draft.phase !== 'editing') return state;
      return {
        selection: {
          kind: 'draft',
          draft: patchDraft(selection.draft, patch),
        },
      };
    }),

    setMessage: (value) => updateActiveComposer(set, get, { message: value }),
    setImages: (images) => updateActiveComposer(set, get, { images: cloneImages(limitOriginImages(images)) }),
    setSkillNames: (skillNames) => updateActiveComposer(set, get, { skillNames: uniqueNames(skillNames) }),

    select: async (sessionId) => {
      const requestOwner = claimRequest(requestOwners);
      const sessionOwner = claimSessionRequest(requestOwners, sessionId);
      const cached = get().sessionById[sessionId];
      set({
        selection: { kind: 'session', sessionId },
        loading: !cached,
        error: null,
      });
      dependencies.preferences.saveLastOpenedSessionId(sessionId);
      if (cached) {
        saveSessionConfig(dependencies.preferences, cached);
        reconcileServerRun({ dependencies, get, set, runOwners, reconcileOwners, sessionId });
        releaseSessionRequest(requestOwners, sessionId, sessionOwner);
        releaseRequest(requestOwners, requestOwner);
        return;
      }
      try {
        const payload = await dependencies.fetchOrigin(sessionId);
        if (ownsSessionRequest(requestOwners, sessionId, sessionOwner)) {
          set((state) => hydrateSessionRun(state, sessionId, payload, runOwners.bySessionId));
          reconcileServerRun({ dependencies, get, set, runOwners, reconcileOwners, sessionId });
        }
        if (ownsRequest(requestOwners, requestOwner) && selectedSessionId(get()) === sessionId) {
          saveSessionConfig(dependencies.preferences, payload);
        }
      } catch (error) {
        if (ownsRequest(requestOwners, requestOwner) && selectedSessionId(get()) === sessionId) {
          set({ error: errorMessage(error) });
        }
      } finally {
        releaseSessionRequest(requestOwners, sessionId, sessionOwner);
        if (releaseRequest(requestOwners, requestOwner)) set({ loading: false });
      }
    },

    remove: async (sessionId) => {
      if (get().runningIds.has(sessionId)) return false;
      const requestOwner = claimRequest(requestOwners);
      supersedeSessionRequest(requestOwners, sessionId);
      cancelReconciliation(reconcileOwners, sessionId);
      reconcileOwners.afterLocalRun.delete(sessionId);
      set({ loading: true, error: null });
      try {
        const payload = await dependencies.deleteOrigin(sessionId);
        supersedeSessionRequest(requestOwners, sessionId);
        set((state) => removeSessionState(
          state,
          sessionId,
          payload.history.sessions,
          runOwners.bySessionId,
        ));
        if (dependencies.preferences.load().lastOpenedSessionId === sessionId) {
          dependencies.preferences.saveLastOpenedSessionId(null);
        }
        return true;
      } catch (error) {
        if (ownsRequest(requestOwners, requestOwner)) set({ error: errorMessage(error) });
        return false;
      } finally {
        if (releaseRequest(requestOwners, requestOwner)) set({ loading: false });
      }
    },

    stop: async (sessionId) => {
      try {
        await dependencies.stopOrigin(sessionId);
        if (runOwners.bySessionId.has(sessionId)) {
          reconcileOwners.afterLocalRun.add(sessionId);
        } else {
          reconcileServerRun({
            dependencies, get, set, runOwners, reconcileOwners, sessionId,
            immediate: true, restart: true, force: true,
          });
        }
      } catch (error) {
        if (selectedSessionId(get()) === sessionId) set({ error: errorMessage(error) });
      }
    },

    send: async () => {
      const selection = get().selection;
      if (!selection) return;
      if (selection.kind === 'draft') {
        await sendDraftOrigin({
          dependencies, get, set, runOwners, requestOwners, reconcileOwners, draft: selection.draft,
        });
        return;
      }
      await sendPersistedOrigin({
        dependencies, get, set, runOwners, requestOwners, reconcileOwners, sessionId: selection.sessionId,
      });
    },
  }));
}

export const useOriginStore = createOriginStore({
  canonicalizeConfig: canonicalizeAvailableOriginConfig,
  waitForRunRefresh: () => new Promise((resolve) => globalThis.setTimeout(resolve, 1_000)),
});

type StoreSet = StoreApi<OriginState>['setState'];
type StoreGet = StoreApi<OriginState>['getState'];

async function sendDraftOrigin(input: {
  dependencies: OriginStoreDependencies;
  get: StoreGet;
  set: StoreSet;
  runOwners: OriginRunOwners;
  requestOwners: OriginRequestOwners;
  reconcileOwners: OriginReconcileOwners;
  draft: OriginDraft;
}): Promise<void> {
  const { dependencies, get, set, runOwners, requestOwners, reconcileOwners } = input;
  const current = get().selection;
  if (current?.kind !== 'draft' || current.draft.materializationId !== input.draft.materializationId) return;
  if (current.draft.phase === 'starting') return;
  const prompt = current.draft.message.trim();
  if (!prompt && current.draft.images.length === 0) return;

  let snapshot = cloneDraft(current.draft);
  set({ selection: { kind: 'draft', draft: { ...snapshot, phase: 'starting' } }, error: null });
  let sessionId: string | null = null;
  let runOwner: number | null = null;
  try {
    snapshot = { ...snapshot, config: await dependencies.canonicalizeConfig(snapshot.config) };
    set((state) => {
      const selected = state.selection;
      if (selected?.kind !== 'draft' || selected.draft.materializationId !== snapshot.materializationId) return {};
      return { selection: { kind: 'draft', draft: { ...snapshot, phase: 'starting' } } };
    });
    const result = await dependencies.streamNewOrigin({
      materializationId: snapshot.materializationId,
      config: snapshot.config,
      message: prompt,
      images: snapshot.images,
      skillNames: snapshot.skillNames,
    }, (materializedId) => {
      sessionId = materializedId;
      runOwner = claimRun(runOwners, materializedId);
      const optimistic = optimisticMessage(materializedId, prompt, snapshot.images, dependencies.now());
      let becameActive = false;
      set((state) => {
        const stillSelected = state.selection?.kind === 'draft'
          && state.selection.draft.materializationId === snapshot.materializationId;
        becameActive = stillSelected;
        return projectRun(state, runningRun(materializedId), {
          selection: stillSelected ? { kind: 'session', sessionId: materializedId } : state.selection,
          sessionById: {
            ...state.sessionById,
            [materializedId]: { session: null, messages: [optimistic] },
          },
          composerBySessionId: {
            ...state.composerBySessionId,
            [materializedId]: emptyComposer(),
          },
          streamingById: { ...state.streamingById, [materializedId]: '' },
          ...(stillSelected ? { error: null } : {}),
        });
      });
      if (becameActive) {
        dependencies.preferences.saveLastConfig(snapshot.config);
        dependencies.preferences.saveLastOpenedSessionId(materializedId);
      }
    }, (event) => {
      if (sessionId && runOwner !== null) {
        applyStreamEvent(set, runOwners, sessionId, runOwner, event);
      }
    });
    if (result.kind === 'already-materialized') {
      const sessionOwner = claimSessionRequest(requestOwners, result.sessionId);
      try {
        const [session, history] = await Promise.all([
          dependencies.fetchOrigin(result.sessionId),
          dependencies.fetchOrigins(),
        ]);
        if (!ownsSessionRequest(requestOwners, result.sessionId, sessionOwner)) return;
        let becameActive = false;
        set((state) => {
          const stillSelected = state.selection?.kind === 'draft'
            && state.selection.draft.materializationId === snapshot.materializationId;
          becameActive = stillSelected;
          const withHistory = {
            ...state,
            ...hydrateHistoryRuns(state, history.sessions, { origins: history.sessions }, runOwners.bySessionId),
          };
          const hydrated = hydrateSessionRun(withHistory, result.sessionId, session, runOwners.bySessionId);
          return {
            ...hydrated,
            selection: stillSelected ? { kind: 'session', sessionId: result.sessionId } : state.selection,
            composerBySessionId: {
              ...state.composerBySessionId,
              [result.sessionId]: emptyComposer(),
            },
            ...(stillSelected ? { error: null } : {}),
          };
        });
        if (becameActive) {
          saveSessionConfig(dependencies.preferences, session);
          dependencies.preferences.saveLastOpenedSessionId(result.sessionId);
        }
        reconcileServerRun({
          dependencies, get, set, runOwners, reconcileOwners, sessionId: result.sessionId,
        });
      } finally {
        releaseSessionRequest(requestOwners, result.sessionId, sessionOwner);
      }
    }
  } catch (error) {
    const message = errorMessage(error);
    set((state) => {
      if (sessionId && runOwner !== null) {
        return failRunState(state, runOwners, sessionId, runOwner, message);
      }
      const stillSelected = state.selection?.kind === 'draft'
        && state.selection.draft.materializationId === snapshot.materializationId;
      return {
        selection: stillSelected
          ? { kind: 'draft', draft: { ...snapshot, phase: 'editing' } }
          : state.selection,
        error: stillSelected ? message : state.error,
      };
    });
  } finally {
    if (sessionId && runOwner !== null) {
      finishRun(set, runOwners, sessionId, runOwner);
      reconcileAfterLocalRun({ dependencies, get, set, runOwners, reconcileOwners, sessionId });
    }
  }
}

async function sendPersistedOrigin(input: {
  dependencies: OriginStoreDependencies;
  get: StoreGet;
  set: StoreSet;
  runOwners: OriginRunOwners;
  requestOwners: OriginRequestOwners;
  reconcileOwners: OriginReconcileOwners;
  sessionId: string;
}): Promise<void> {
  const { dependencies, get, set, runOwners, requestOwners, reconcileOwners, sessionId } = input;
  const initial = get();
  if (initial.runningIds.has(sessionId)) return;
  const composer = cloneComposer(initial.composerBySessionId[sessionId] ?? emptyComposer());
  const prompt = composer.message.trim();
  if (!prompt && composer.images.length === 0) return;
  const optimistic = optimisticMessage(sessionId, prompt, composer.images, dependencies.now());
  supersedeSessionRequest(requestOwners, sessionId);
  cancelReconciliation(reconcileOwners, sessionId);
  const runOwner = claimRun(runOwners, sessionId);
  set((state) => {
    const previous = state.sessionById[sessionId] ?? { session: null, messages: [] };
    return projectRun(state, runningRun(sessionId), {
      sessionById: {
        ...state.sessionById,
        [sessionId]: { ...previous, messages: [...previous.messages, optimistic] },
      },
      composerBySessionId: { ...state.composerBySessionId, [sessionId]: emptyComposer() },
      streamingById: { ...state.streamingById, [sessionId]: '' },
      error: null,
    });
  });
  try {
    await dependencies.streamOriginMessage(sessionId, prompt, {
      images: composer.images,
      skillNames: composer.skillNames,
    }, (event) => applyStreamEvent(set, runOwners, sessionId, runOwner, event));
  } catch (error) {
    const message = errorMessage(error);
    if (error instanceof HttpResponseError) {
      set((state) => rollbackRejectedRun(
        state,
        runOwners,
        sessionId,
        runOwner,
        optimistic.id,
        composer,
        message,
      ));
      if (error.status === 409) reconcileOwners.afterLocalRun.add(sessionId);
    } else {
      set((state) => failRunState(state, runOwners, sessionId, runOwner, message));
    }
  } finally {
    finishRun(set, runOwners, sessionId, runOwner);
    reconcileAfterLocalRun({ dependencies, get, set, runOwners, reconcileOwners, sessionId });
  }
}

function applyStreamEvent(
  set: StoreSet,
  runOwners: OriginRunOwners,
  expectedSessionId: string,
  runOwner: number,
  envelope: OriginStreamEvent,
): void {
  if (envelope.sessionId !== expectedSessionId) return;
  const sessionId = envelope.sessionId;
  const event = envelope.event;
  set((state) => {
    if (!ownsRun(runOwners, sessionId, runOwner)) return {};
    const run = advanceRun(state.runBySessionId[sessionId], envelope);
    if (!run) return {};

    if (event.type === 'message_update') {
      return projectRun(state, run, {
        streamingById: {
          ...state.streamingById,
          [sessionId]: (state.streamingById[sessionId] ?? '') + (event.delta ?? ''),
        },
      });
    }
    if (event.type === 'message_end' && event.message.role !== 'user') {
      const message: AgentMessage = {
        id: event.message.id ?? `origin-message-${Date.now()}-${++optimisticId}`,
        sessionId,
        role: event.message.role ?? 'assistant',
        content: event.message.content ?? '',
        createdAt: event.message.createdAt ?? new Date().toISOString(),
        metadata: event.message.metadata ?? null,
        error: event.message.error ?? null,
      };
      const previous = state.sessionById[sessionId] ?? { session: null, messages: [] };
      const streamingById = { ...state.streamingById };
      if (message.role === 'assistant') delete streamingById[sessionId];
      return projectRun(state, run, {
        sessionById: {
          ...state.sessionById,
          [sessionId]: { ...previous, messages: [...previous.messages, message] },
        },
        streamingById,
      });
    }
    if (event.type === 'session_update') {
      const runBySessionId = mergeHistoryRuns(
        state.runBySessionId,
        event.history.sessions,
        runOwners.bySessionId,
      );
      runBySessionId[sessionId] = run;
      return projectRuns(state, runBySessionId, {
        origins: event.history.sessions,
        sessionById: { ...state.sessionById, [sessionId]: event.session },
      });
    }
    const visibleError = event.type === 'error'
      ? event.error
      : event.type === 'agent_end' && event.errorCode !== 'aborted' ? event.error : null;
    return projectRun(state, run, visibleError && selectedSessionId(state) === sessionId
      ? { error: visibleError }
      : {});
  });
}

function updateActiveComposer(
  set: StoreSet,
  get: StoreGet,
  patch: Partial<OriginComposerDraft>,
): void {
  const selection = get().selection;
  if (!selection) return;
  if (selection.kind === 'draft') {
    get().updateDraft(patch);
    return;
  }
  set((state) => ({
    composerBySessionId: {
      ...state.composerBySessionId,
      [selection.sessionId]: {
        ...(state.composerBySessionId[selection.sessionId] ?? emptyComposer()),
        ...patch,
      },
    },
  }));
}

function patchDraft(draft: OriginDraft, patch: OriginDraftPatch): OriginDraft {
  return {
    ...draft,
    config: patch.config ? transitionOriginConfig(draft.config, patch.config) : draft.config,
    message: patch.message ?? draft.message,
    images: patch.images ? cloneImages(limitOriginImages(patch.images)) : draft.images,
    skillNames: patch.skillNames ? uniqueNames(patch.skillNames) : draft.skillNames,
  };
}

function removeSessionState(
  state: OriginState,
  sessionId: string,
  origins: OriginSessionSummary[],
  protectedRuns?: Pick<Map<string, number>, 'has'>,
): Partial<OriginState> {
  const sessionById = { ...state.sessionById };
  const composerBySessionId = { ...state.composerBySessionId };
  const streamingById = { ...state.streamingById };
  const runBySessionId = mergeHistoryRuns(state.runBySessionId, origins, protectedRuns);
  delete sessionById[sessionId];
  delete composerBySessionId[sessionId];
  delete streamingById[sessionId];
  delete runBySessionId[sessionId];
  return projectRuns(state, runBySessionId, {
    origins,
    sessionById,
    composerBySessionId,
    streamingById,
    selection: state.selection?.kind === 'session' && state.selection.sessionId === sessionId
      ? null
      : state.selection,
  });
}

function hydrateHistoryRuns(
  state: OriginState,
  origins: OriginSessionSummary[],
  patch: Partial<OriginState> = {},
  protectedRuns?: Pick<Map<string, number>, 'has'>,
): Partial<OriginState> {
  const runBySessionId = mergeHistoryRuns(state.runBySessionId, origins, protectedRuns);
  return projectRuns(state, runBySessionId, patch);
}

function mergeHistoryRuns(
  previous: Record<string, AgentSessionRun>,
  origins: OriginSessionSummary[],
  protectedRuns?: Pick<Map<string, number>, 'has'>,
): Record<string, AgentSessionRun> {
  const runBySessionId = { ...previous };
  for (const origin of origins) {
    if (protectedRuns?.has(origin.id)) continue;
    runBySessionId[origin.id] = origin.run ?? idleRun(origin.id);
  }
  return runBySessionId;
}

function hydrateSessionRun(
  state: OriginState,
  sessionId: string,
  payload: OriginSessionResponse,
  protectedRuns?: Pick<Map<string, number>, 'has'>,
): Partial<OriginState> {
  const run = protectedRuns?.has(sessionId)
    ? state.runBySessionId[sessionId] ?? runningRun(sessionId)
    : payload.run ?? state.runBySessionId[sessionId] ?? idleRun(sessionId);
  return projectRun(state, run, {
    sessionById: { ...state.sessionById, [sessionId]: payload },
  });
}

function runningIdsFrom(runBySessionId: Record<string, AgentSessionRun>): Set<string> {
  return new Set(Object.values(runBySessionId)
    .filter((run) => run.status === 'running')
    .map((run) => run.sessionId));
}

function idleRun(sessionId: string): AgentSessionRun {
  return {
    sessionId,
    runId: null,
    status: 'idle',
    activeFlags: [],
    lastSeq: 0,
    error: null,
  };
}

function saveSessionConfig(preferences: OriginPreferencesAdapter, payload: OriginSessionResponse): void {
  const session = payload.session;
  if (!session) return;
  preferences.saveLastConfig({
    runtime: session.runtime,
    provider: session.provider,
    model: session.model || null,
    reasoningEffort: session.reasoningEffort,
  });
}

function optimisticMessage(
  sessionId: string,
  content: string,
  images: ImageAttachment[],
  now: Date,
): AgentMessage {
  return {
    id: `origin-user-${now.getTime()}-${++optimisticId}`,
    sessionId,
    role: 'user',
    content,
    createdAt: now.toISOString(),
    metadata: images.length > 0 ? { images: cloneImages(images) } : null,
    error: null,
  };
}

function claimRun(runOwners: OriginRunOwners, sessionId: string): number {
  const owner = ++runOwners.next;
  runOwners.bySessionId.set(sessionId, owner);
  return owner;
}

function claimRequest(requestOwners: OriginRequestOwners): number {
  const owner = ++requestOwners.next;
  requestOwners.active = owner;
  return owner;
}

function ownsRequest(requestOwners: OriginRequestOwners, owner: number): boolean {
  return requestOwners.active === owner;
}

function releaseRequest(requestOwners: OriginRequestOwners, owner: number): boolean {
  if (!ownsRequest(requestOwners, owner)) return false;
  requestOwners.active = null;
  return true;
}

function supersedeRequest(requestOwners: OriginRequestOwners): void {
  requestOwners.active = null;
}

function claimSessionRequest(requestOwners: OriginRequestOwners, sessionId: string): number {
  const owner = ++requestOwners.next;
  requestOwners.bySessionId.set(sessionId, owner);
  return owner;
}

function ownsSessionRequest(
  requestOwners: OriginRequestOwners,
  sessionId: string,
  owner: number,
): boolean {
  return requestOwners.bySessionId.get(sessionId) === owner;
}

function releaseSessionRequest(
  requestOwners: OriginRequestOwners,
  sessionId: string,
  owner: number,
): void {
  if (ownsSessionRequest(requestOwners, sessionId, owner)) requestOwners.bySessionId.delete(sessionId);
}

function supersedeSessionRequest(requestOwners: OriginRequestOwners, sessionId: string): void {
  requestOwners.bySessionId.set(sessionId, ++requestOwners.next);
}

function reconcileRunningSummaries(input: {
  dependencies: OriginStoreDependencies;
  get: StoreGet;
  set: StoreSet;
  runOwners: OriginRunOwners;
  reconcileOwners: OriginReconcileOwners;
  summaries: OriginSessionSummary[];
}): void {
  for (const summary of input.summaries) {
    if (summary.run?.status === 'running') {
      reconcileServerRun({ ...input, sessionId: summary.id });
    }
  }
}

function reconcileServerRun(input: {
  dependencies: OriginStoreDependencies;
  get: StoreGet;
  set: StoreSet;
  runOwners: OriginRunOwners;
  reconcileOwners: OriginReconcileOwners;
  sessionId: string;
  immediate?: boolean;
  restart?: boolean;
  force?: boolean;
}): void {
  const { dependencies, get, set, runOwners, reconcileOwners, sessionId } = input;
  if (!dependencies.waitForRunRefresh || runOwners.bySessionId.has(sessionId)) return;
  if (!input.force && get().runBySessionId[sessionId]?.status !== 'running') {
    cancelReconciliation(reconcileOwners, sessionId);
    return;
  }
  if (input.restart) cancelReconciliation(reconcileOwners, sessionId);
  if (reconcileOwners.bySessionId.has(sessionId)) return;

  const owner = ++reconcileOwners.next;
  reconcileOwners.bySessionId.set(sessionId, owner);
  void (async () => {
    let immediate = input.immediate === true;
    try {
      while (ownsReconciliation(reconcileOwners, sessionId, owner)) {
        if (!immediate) {
          try {
            await dependencies.waitForRunRefresh!();
          } catch {
            return;
          }
        }
        immediate = false;
        if (!ownsReconciliation(reconcileOwners, sessionId, owner)
          || runOwners.bySessionId.has(sessionId)) return;

        let run: AgentSessionRun;
        try {
          ({ run } = await dependencies.fetchOriginRun(sessionId));
        } catch {
          continue;
        }
        if (!ownsReconciliation(reconcileOwners, sessionId, owner)
          || runOwners.bySessionId.has(sessionId)) return;

        if (run.status === 'running') {
          set((state) => ({
            ...projectRun(state, run),
            ...(selectedSessionId(state) === sessionId ? { error: null } : {}),
          }));
          continue;
        }

        let payload: OriginSessionResponse | null = null;
        try {
          payload = await dependencies.fetchOrigin(sessionId);
        } catch {
          // Run truth is settled; transcript refresh can retry on selection.
        }
        if (!ownsReconciliation(reconcileOwners, sessionId, owner)
          || runOwners.bySessionId.has(sessionId)) return;
        const finalRun = payload?.run ?? run;
        set((state) => ({
          ...(payload
            ? hydrateSessionRun(state, sessionId, { ...payload, run: finalRun })
            : projectRun(state, finalRun)),
          ...(selectedSessionId(state) === sessionId ? { error: null } : {}),
        }));
        if (finalRun.status !== 'running') return;
      }
    } finally {
      releaseReconciliation(reconcileOwners, sessionId, owner);
    }
  })();
}

function ownsReconciliation(
  owners: OriginReconcileOwners,
  sessionId: string,
  owner: number,
): boolean {
  return owners.bySessionId.get(sessionId) === owner;
}

function releaseReconciliation(
  owners: OriginReconcileOwners,
  sessionId: string,
  owner: number,
): void {
  if (ownsReconciliation(owners, sessionId, owner)) owners.bySessionId.delete(sessionId);
}

function cancelReconciliation(owners: OriginReconcileOwners, sessionId: string): void {
  owners.bySessionId.delete(sessionId);
}

function cancelAllReconciliations(owners: OriginReconcileOwners): void {
  owners.bySessionId.clear();
  owners.afterLocalRun.clear();
}

function reconcileAfterLocalRun(input: {
  dependencies: OriginStoreDependencies;
  get: StoreGet;
  set: StoreSet;
  runOwners: OriginRunOwners;
  reconcileOwners: OriginReconcileOwners;
  sessionId: string;
}): void {
  if (!input.reconcileOwners.afterLocalRun.delete(input.sessionId)) return;
  reconcileServerRun({
    ...input,
    immediate: true,
    restart: true,
    force: true,
  });
}

function ownsRun(runOwners: OriginRunOwners, sessionId: string, owner: number): boolean {
  return runOwners.bySessionId.get(sessionId) === owner;
}

function finishRun(
  set: StoreSet,
  runOwners: OriginRunOwners,
  sessionId: string,
  owner: number,
): void {
  set((state) => {
    if (!ownsRun(runOwners, sessionId, owner)) return {};
    runOwners.bySessionId.delete(sessionId);
    const streamingById = { ...state.streamingById };
    delete streamingById[sessionId];
    const previous = state.runBySessionId[sessionId] ?? idleRun(sessionId);
    const run = previous.status === 'running'
      ? { ...previous, status: 'idle' as const }
      : previous;
    return projectRun(state, run, { streamingById });
  });
}

function failRunState(
  state: OriginState,
  runOwners: OriginRunOwners,
  sessionId: string,
  owner: number,
  error: string,
): Partial<OriginState> {
  if (!ownsRun(runOwners, sessionId, owner)) return {};
  const previous = state.runBySessionId[sessionId] ?? runningRun(sessionId);
  return projectRun(state, { ...previous, status: 'error', error }, {
    ...(selectedSessionId(state) === sessionId ? { error } : {}),
  });
}

function rollbackRejectedRun(
  state: OriginState,
  runOwners: OriginRunOwners,
  sessionId: string,
  owner: number,
  optimisticMessageId: AgentMessage['id'],
  composer: OriginComposerDraft,
  error: string,
): Partial<OriginState> {
  if (!ownsRun(runOwners, sessionId, owner)) return {};
  const previous = state.sessionById[sessionId] ?? { session: null, messages: [] };
  const run = state.runBySessionId[sessionId] ?? runningRun(sessionId);
  return projectRun(state, { ...run, status: 'error', error }, {
    sessionById: {
      ...state.sessionById,
      [sessionId]: {
        ...previous,
        messages: previous.messages.filter((message) => message.id !== optimisticMessageId),
      },
    },
    composerBySessionId: {
      ...state.composerBySessionId,
      [sessionId]: restoreRejectedComposer(
        composer,
        state.composerBySessionId[sessionId] ?? emptyComposer(),
      ),
    },
    ...(selectedSessionId(state) === sessionId ? { error } : {}),
  });
}

function restoreRejectedComposer(
  rejected: OriginComposerDraft,
  current: OriginComposerDraft,
): OriginComposerDraft {
  if (!current.message && current.images.length === 0 && current.skillNames.length === 0) {
    return cloneComposer(rejected);
  }
  const message = !rejected.message ? current.message
    : !current.message || current.message === rejected.message ? rejected.message
      : `${rejected.message}\n\n${current.message}`;
  const images = cloneImages(current.images);
  for (const image of rejected.images) {
    if (images.length >= 10) break;
    if (!images.some((candidate) => candidate.data === image.data && candidate.mimeType === image.mimeType)) {
      images.push({ ...image });
    }
  }
  return {
    message,
    images,
    skillNames: uniqueNames([...rejected.skillNames, ...current.skillNames]),
  };
}

function advanceRun(
  previous: AgentSessionRun | undefined,
  envelope: OriginStreamEvent,
): AgentSessionRun | null {
  const current = previous ?? runningRun(envelope.sessionId);
  const runId = envelope.runId.trim();
  if (current.runId && current.runId !== runId) return null;
  if (!(runId === '' && envelope.seq === 0) && envelope.seq <= current.lastSeq) return null;

  const event = envelope.event;
  const status = event.type === 'agent_end'
    ? (event.error && event.errorCode !== 'aborted' ? 'error' : 'idle')
    : event.type === 'error'
      ? 'error'
      : event.type === 'session_update'
        ? current.status
        : 'running';
  const error = event.type === 'error'
    ? event.error
    : event.type === 'agent_end'
      ? event.errorCode === 'aborted' ? null : event.error
      : status === 'running' ? null : current.error;
  return {
    ...current,
    sessionId: envelope.sessionId,
    runId: runId || current.runId,
    status,
    lastSeq: envelope.seq,
    error,
  };
}

function runningRun(sessionId: string): AgentSessionRun {
  return { ...idleRun(sessionId), status: 'running' };
}

function projectRun(
  state: OriginState,
  run: AgentSessionRun,
  patch: Partial<OriginState> = {},
): Partial<OriginState> {
  const runBySessionId = { ...state.runBySessionId, [run.sessionId]: run };
  return projectRuns(state, runBySessionId, patch);
}

function projectRuns(
  state: OriginState,
  runBySessionId: Record<string, AgentSessionRun>,
  patch: Partial<OriginState> = {},
): Partial<OriginState> {
  const sourceOrigins = patch.origins ?? state.origins;
  const sourceSessions = patch.sessionById ?? state.sessionById;
  const sessionById = { ...sourceSessions };
  for (const [sessionId, cached] of Object.entries(sourceSessions)) {
    const run = runBySessionId[sessionId];
    if (run) sessionById[sessionId] = { ...cached, run };
  }
  return {
    ...patch,
    origins: sourceOrigins.map((origin) => (
      runBySessionId[origin.id] ? { ...origin, run: runBySessionId[origin.id] } : origin
    )),
    sessionById,
    runBySessionId,
    runningIds: runningIdsFrom(runBySessionId),
  };
}

function selectedSessionId(state: Pick<OriginState, 'selection'>): string | null {
  return state.selection?.kind === 'session' ? state.selection.sessionId : null;
}

function cloneDraft(draft: OriginDraft): OriginDraft {
  return {
    ...draft,
    config: { ...draft.config },
    images: cloneImages(draft.images),
    skillNames: [...draft.skillNames],
  };
}

function cloneComposer(composer: OriginComposerDraft): OriginComposerDraft {
  return {
    message: composer.message,
    images: cloneImages(composer.images),
    skillNames: [...composer.skillNames],
  };
}

function cloneImages(images: ImageAttachment[]): ImageAttachment[] {
  return images.map((image) => ({ ...image }));
}

function emptyComposer(): OriginComposerDraft {
  return { message: '', images: [], skillNames: [] };
}

function uniqueNames(names: string[]): string[] {
  return [...new Set(names.map((name) => name.trim()).filter(Boolean))];
}

function randomId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return `origin-draft-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
