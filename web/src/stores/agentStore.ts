/** 管理 Agent 选择、Session 历史、流式消息和操作状态的 Zustand store。 */
import { create } from 'zustand';
import type {
  AgentContextUsage,
  AgentMessage,
  AgentModelRegistry,
  AgentSessionResponse,
  AgentSessionRun,
  AgentSessionStats,
  AgentSessionSummary,
  QueuedSteeringMessage,
} from '../types';
import {
  abortAgentSession,
  createAgentSession,
  deleteAgentSessionById,
  fetchAgentModelRegistry,
  fetchAgentSession,
  fetchAgentSessions,
  steerAgentSession,
  streamAgentMessage,
  type ImageAttachment,
} from '../api';

const STORAGE_KEY_PROVIDER = 'tradex-agent-provider';
const STORAGE_KEY_MODELS = 'tradex-agent-models-by-provider';

function loadPersistedProvider(): string {
  try {
    const stored = localStorage.getItem(STORAGE_KEY_PROVIDER);
    if (stored) return stored;
  } catch {}
  return '';
}

function loadPersistedModels(): Record<string, string> {
  try {
    const stored = localStorage.getItem(STORAGE_KEY_MODELS);
    if (!stored) return {};
    const parsed = JSON.parse(stored) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return Object.fromEntries(
        Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
      );
    }
  } catch {}
  return {};
}

function persistProviderModel(provider: string, model: string): void {
  try {
    localStorage.setItem(STORAGE_KEY_PROVIDER, provider);
    const models = loadPersistedModels();
    if (provider && model) models[provider] = model;
    localStorage.setItem(STORAGE_KEY_MODELS, JSON.stringify(models));
  } catch {}
}

function selectableModels(registry: AgentModelRegistry | null, provider?: string) {
  return registry?.models.filter((model) => (
    model.selected && model.runnable && (!provider || model.providerId === provider)
  )) ?? [];
}

function registrySelection(
  registry: AgentModelRegistry,
  provider: string,
  model: string,
): { provider: string; model: string } {
  const persistedModels = loadPersistedModels();
  const canonicalProvider = registry.providers.find((item) => (
    item.providerId === provider || item.configProviderId === provider
  ))?.providerId ?? provider;
  const providerModels = selectableModels(registry, canonicalProvider);
  const remembered = persistedModels[canonicalProvider] ?? persistedModels[provider];
  const selected = providerModels.find((item) => item.id === model)
    ?? providerModels.find((item) => item.id === remembered)
    ?? providerModels[0]
    ?? selectableModels(registry)[0];
  return selected
    ? { provider: selected.providerId, model: selected.id }
    : { provider: canonicalProvider, model };
}

const initialProvider = loadPersistedProvider();
const initialModels = loadPersistedModels();
import { useMarketStore } from './marketStore';

type ContextUsage = AgentContextUsage | null;
type SessionStatsState = AgentSessionStats | null;

interface SessionRunProjection extends AgentSessionRun {
  pendingToolCalls: Set<string>;
  contextUsage: ContextUsage;
  sessionStats: SessionStatsState;
}

interface AgentState {
  agentSession: AgentSessionResponse | null;
  agentSessionHistory: AgentSessionSummary[];
  agentSessionLoadingKey: string | null;
  agentSessionHistoryLoadingKey: string | null;
  agentSessionActionKey: string | null;
  agentBusyKey: string | null;
  agentPrompt: string;
  agentProvider: string;
  agentModel: string;
  pendingToolCalls: Set<string>;
  modelRegistry: AgentModelRegistry | null;
  modelRegistryLoading: boolean;
  contextUsage: ContextUsage;
  sessionStats: SessionStatsState;
  activeAgentSessionId: string | null;
  agentSessionById: Record<string, AgentSessionResponse>;
  runStateBySessionId: Record<string, SessionRunProjection>;
  draftBySessionId: Record<string, string>;
  /** The assistant message currently being streamed (dual-zone pattern). */
  streamingMessage: AgentMessage | null;
  /**
   * Steering messages sent to a running agent but not yet confirmed by the
   * backend, keyed by session id. Rendered in a fixed pending region below the
   * transcript instead of being spliced into `messages`, so their position
   * stays stable while the agent streams.
   */
  queuedSteeringBySessionId: Record<string, QueuedSteeringMessage[]>;
  /** Queued steering messages for the currently-active session (derived). */
  queuedSteering: QueuedSteeringMessage[];
  /**
   * Image attachments queued for the next send, keyed by session id.
   * The active session's bucket is mirrored to `pendingImages` for read-only
   * consumers; mutations always go through this map so switching sessions
   * preserves each session's draft attachments.
   */
  pendingImagesBySessionId: Record<string, ImageAttachment[]>;
  /** Pending images for the currently-active session (derived). */
  pendingImages: ImageAttachment[];

  setAgentSession: (session: AgentSessionResponse | null) => void;
  setAgentSessionHistory: (history: AgentSessionSummary[]) => void;
  setAgentPrompt: (prompt: string) => void;
  setAgentProvider: (provider: string) => void;
  setAgentModel: (model: string) => void;
  addPendingImage: (image: ImageAttachment) => void;
  removePendingImage: (index: number) => void;
  clearPendingImages: () => void;
  changeProviderModel: (provider: string, defaultModel: string) => void;

  initSessions: () => () => void;
  refreshModelRegistry: () => Promise<void>;
  runAgentAnalysis: () => Promise<void>;
  steerAgent: () => Promise<void>;
  abortAgent: () => Promise<void>;
  resetAgentConversation: (agentId?: string) => Promise<void>;
  resumeAgentConversation: (sessionId: string) => Promise<void>;
  deleteAgentConversation: (sessionId: string) => Promise<void>;
}

type ActiveMirrorSource = Pick<
  AgentState,
  'activeAgentSessionId' | 'agentSessionById' | 'agentSessionHistory' | 'runStateBySessionId' | 'draftBySessionId' | 'pendingImagesBySessionId' | 'queuedSteeringBySessionId'
>;

const NEW_SESSION_PENDING_KEY = '__new__';
let modelRegistryRequest: Promise<AgentModelRegistry> | null = null;

function idleRun(sessionId: string): SessionRunProjection {
  return {
    sessionId,
    runId: null,
    status: 'idle',
    activeFlags: [],
    lastSeq: 0,
    error: null,
    pendingToolCalls: new Set(),
    contextUsage: null,
    sessionStats: null,
  };
}

function mergeRunPayload(
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
    contextUsage: previous?.contextUsage ?? null,
    sessionStats: previous?.sessionStats ?? null,
  };
}

function mergeHistoryRuns(
  history: AgentSessionSummary[],
  previous: Record<string, SessionRunProjection>,
): Record<string, SessionRunProjection> {
  const next = { ...previous };
  for (const item of history) {
    next[item.id] = mergeRunPayload(next[item.id], item.id, item.run);
  }
  return next;
}

function sessionFromSummary(summary: AgentSessionSummary): AgentSessionResponse {
  return { session: summary, messages: [], contextUsage: summary.contextUsage ?? null, sessionStats: summary.sessionStats ?? null, run: summary.run };
}

function visibleSession(state: ActiveMirrorSource): AgentSessionResponse | null {
  const activeId = state.activeAgentSessionId;
  if (!activeId) return null;
  const cached = state.agentSessionById[activeId];
  if (cached) return cached;
  const summary = state.agentSessionHistory.find((item) => item.id === activeId);
  return summary ? sessionFromSummary(summary) : null;
}

function pendingImagesKey(activeId: string | null): string {
  return activeId ?? NEW_SESSION_PENDING_KEY;
}

function activeFields(state: ActiveMirrorSource): Pick<
  AgentState,
  'agentSession' | 'agentPrompt' | 'pendingToolCalls' | 'contextUsage' | 'sessionStats' | 'agentBusyKey' | 'pendingImages' | 'queuedSteering'
> {
  const activeId = state.activeAgentSessionId;
  const run = activeId ? state.runStateBySessionId[activeId] : undefined;
  const session = visibleSession(state);
  const key = pendingImagesKey(activeId);
  return {
    agentSession: session,
    agentPrompt: activeId ? state.draftBySessionId[activeId] ?? '' : '',
    pendingToolCalls: new Set(run?.pendingToolCalls ?? []),
    contextUsage: run?.contextUsage ?? session?.contextUsage ?? null,
    sessionStats: run?.sessionStats ?? session?.sessionStats ?? null,
    agentBusyKey: activeId && run?.status === 'running' ? activeId : null,
    pendingImages: state.pendingImagesBySessionId[key] ?? [],
    queuedSteering: activeId ? state.queuedSteeringBySessionId[activeId] ?? [] : [],
  };
}

function appendSessionMessage(
  state: AgentState,
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

/**
 * Remove the first queued steering message matching `content` from a session's
 * pending queue. Called when the backend confirms a steered user message,
 * which is the moment it transitions from the pending region into `messages`.
 */
function removeQueuedSteering(
  map: Record<string, QueuedSteeringMessage[]>,
  sessionId: string,
  content: string,
): Record<string, QueuedSteeringMessage[]> {
  const queue = map[sessionId];
  if (!queue || queue.length === 0) return map;
  const index = queue.findIndex((item) => item.content === content);
  if (index === -1) return map;
  const next = [...queue.slice(0, index), ...queue.slice(index + 1)];
  return { ...map, [sessionId]: next };
}

function cacheSession(
  cache: Record<string, AgentSessionResponse>,
  payload: AgentSessionResponse,
): Record<string, AgentSessionResponse> {
  const sessionId = payload.session?.id;
  return sessionId ? { ...cache, [sessionId]: payload } : cache;
}

function sessionProviderModel(payload: AgentSessionResponse | null): Partial<Pick<AgentState, 'agentProvider' | 'agentModel'>> {
  const session = payload?.session;
  if (!session?.provider || !session.model) return {};
  persistProviderModel(session.provider, session.model);
  return { agentProvider: session.provider, agentModel: session.model };
}

function responseForSession(state: AgentState, sessionId: string): AgentSessionResponse {
  const cached = state.agentSessionById[sessionId];
  if (cached) return cached;
  const summary = state.agentSessionHistory.find((item) => item.id === sessionId);
  return summary ? sessionFromSummary(summary) : { session: null, messages: [] };
}


function upsertOptimisticSessionSummary(
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
        contextUsage: payload.contextUsage ?? null,
        run,
      };
  return [summary, ...history.filter((item) => item.id !== summary.id)];
}

function replaceRunState(
  map: Record<string, SessionRunProjection>,
  sessionId: string,
  run: SessionRunProjection,
): Record<string, SessionRunProjection> {
  return { ...map, [sessionId]: run };
}

export const useAgentStore = create<AgentState>((set, get) => ({
  agentSession: null,
  agentSessionHistory: [],
  agentSessionLoadingKey: null,
  agentSessionHistoryLoadingKey: null,
  agentSessionActionKey: null,
  agentBusyKey: null,
  agentPrompt: '',
  agentProvider: initialProvider,
  agentModel: initialModels[initialProvider] ?? '',
  pendingToolCalls: new Set(),
  modelRegistry: null,
  modelRegistryLoading: false,
  contextUsage: null,
  sessionStats: null,
  activeAgentSessionId: null,
  agentSessionById: {},
  runStateBySessionId: {},
  draftBySessionId: {},
  streamingMessage: null,
  queuedSteeringBySessionId: {},
  queuedSteering: [],
  pendingImagesBySessionId: {},
  pendingImages: [],

  setAgentSession: (session) => set((s) => {
    const activeAgentSessionId = session?.session?.id ?? null;
    const agentSessionById = session ? cacheSession(s.agentSessionById, session) : s.agentSessionById;
    const runStateBySessionId = activeAgentSessionId
      ? {
          ...s.runStateBySessionId,
          [activeAgentSessionId]: mergeRunPayload(
            s.runStateBySessionId[activeAgentSessionId],
            activeAgentSessionId,
            session?.run,
          ),
        }
      : s.runStateBySessionId;
    const next = { ...s, activeAgentSessionId, agentSessionById, runStateBySessionId };
    return {
      activeAgentSessionId,
      agentSessionById,
      runStateBySessionId,
      ...sessionProviderModel(session),
      ...activeFields(next),
    };
  }),
  setAgentSessionHistory: (history) => set((s) => {
    const runStateBySessionId = mergeHistoryRuns(history, s.runStateBySessionId);
    const next = { ...s, agentSessionHistory: history, runStateBySessionId };
    return { agentSessionHistory: history, runStateBySessionId, ...activeFields(next) };
  }),
  setAgentPrompt: (prompt) => set((s) => ({
    agentPrompt: prompt,
    draftBySessionId: s.activeAgentSessionId
      ? { ...s.draftBySessionId, [s.activeAgentSessionId]: prompt }
      : s.draftBySessionId,
  })),
  setAgentProvider: (provider) => {
    const current = get();
    const selection = current.modelRegistry
      ? registrySelection(current.modelRegistry, provider, '')
      : { provider, model: loadPersistedModels()[provider] ?? '' };
    set({ agentProvider: selection.provider, agentModel: selection.model });
    persistProviderModel(selection.provider, selection.model);
  },
  setAgentModel: (model) => {
    set({ agentModel: model });
    persistProviderModel(get().agentProvider, model);
  },
  addPendingImage: (image) => set((s) => {
    const key = pendingImagesKey(s.activeAgentSessionId);
    const current = s.pendingImagesBySessionId[key] ?? [];
    const pendingImagesBySessionId = { ...s.pendingImagesBySessionId, [key]: [...current, image] };
    const next = { ...s, pendingImagesBySessionId };
    return { pendingImagesBySessionId, ...activeFields(next) };
  }),
  removePendingImage: (index) => set((s) => {
    const key = pendingImagesKey(s.activeAgentSessionId);
    const current = s.pendingImagesBySessionId[key] ?? [];
    if (index < 0 || index >= current.length) return s;
    const updated = current.filter((_, i) => i !== index);
    const pendingImagesBySessionId = { ...s.pendingImagesBySessionId };
    if (updated.length === 0) delete pendingImagesBySessionId[key];
    else pendingImagesBySessionId[key] = updated;
    const next = { ...s, pendingImagesBySessionId };
    return { pendingImagesBySessionId, ...activeFields(next) };
  }),
  clearPendingImages: () => set((s) => {
    const key = pendingImagesKey(s.activeAgentSessionId);
    if (!(key in s.pendingImagesBySessionId)) return s;
    const pendingImagesBySessionId = { ...s.pendingImagesBySessionId };
    delete pendingImagesBySessionId[key];
    const next = { ...s, pendingImagesBySessionId };
    return { pendingImagesBySessionId, ...activeFields(next) };
  }),
  changeProviderModel: (provider, defaultModel) => {
    set({ agentProvider: provider, agentModel: defaultModel });
    persistProviderModel(provider, defaultModel);
  },

  refreshModelRegistry: async () => {
    set({ modelRegistryLoading: true });
    try {
      modelRegistryRequest ??= fetchAgentModelRegistry().finally(() => {
        modelRegistryRequest = null;
      });
      const registry = await modelRegistryRequest;
      const current = get();
      if (current.modelRegistry?.generation === registry.generation) return;
      const selection = registrySelection(registry, current.agentProvider, current.agentModel);
      set({
        modelRegistry: registry,
        agentProvider: selection.provider,
        agentModel: selection.model,
      });
      persistProviderModel(selection.provider, selection.model);
    } catch (error) {
      console.error('model registry refresh failed:', error);
    } finally {
      set({ modelRegistryLoading: false });
    }
  },

  initSessions: () => {
    let disposed = false;
    const key = 'global';
    set({ agentSessionHistoryLoadingKey: key });
    fetchAgentSessions()
      .then((payload) => {
        if (disposed) return;
        const firstSessionId = payload.sessions[0]?.id ?? null;
        const preloadedSessions = payload.preloadedSessions ?? [];
        set((s) => {
          let agentSessionById = s.agentSessionById;
          let runStateBySessionId = mergeHistoryRuns(payload.sessions, s.runStateBySessionId);
          for (const sessionPayload of preloadedSessions) {
            const sessionId = sessionPayload.session?.id;
            if (!sessionId) continue;
            agentSessionById = cacheSession(agentSessionById, sessionPayload);
            runStateBySessionId = {
              ...runStateBySessionId,
              [sessionId]: mergeRunPayload(runStateBySessionId[sessionId], sessionId, sessionPayload.run),
            };
          }
          const next = {
            ...s,
            agentSessionById,
            agentSessionHistory: payload.sessions,
            runStateBySessionId,
            activeAgentSessionId: s.activeAgentSessionId ?? firstSessionId,
          };
          const activeSummary = payload.sessions.find((item) => item.id === next.activeAgentSessionId);
          const activeSession = next.activeAgentSessionId
            ? agentSessionById[next.activeAgentSessionId]
              ?? (activeSummary ? sessionFromSummary(activeSummary) : null)
            : null;
          return {
            agentSessionById,
            agentSessionHistory: payload.sessions,
            runStateBySessionId,
            activeAgentSessionId: next.activeAgentSessionId,
            ...sessionProviderModel(activeSession),
            ...activeFields(next),
          };
        });
        const activeSessionId = get().activeAgentSessionId ?? firstSessionId;
        if (activeSessionId && !get().agentSessionById[activeSessionId]) {
          set({ agentSessionLoadingKey: key });
          fetchAgentSession(activeSessionId)
            .then((sessionPayload) => {
              if (disposed) return;
              set((s) => {
                const sessionId = sessionPayload.session?.id ?? activeSessionId;
                const agentSessionById = cacheSession(s.agentSessionById, sessionPayload);
                const runStateBySessionId = {
                  ...s.runStateBySessionId,
                  [sessionId]: mergeRunPayload(s.runStateBySessionId[sessionId], sessionId, sessionPayload.run),
                };
                const next = { ...s, agentSessionById, runStateBySessionId, activeAgentSessionId: sessionId };
                return {
                  agentSessionById,
                  runStateBySessionId,
                  activeAgentSessionId: sessionId,
                  ...sessionProviderModel(sessionPayload),
                  ...activeFields(next),
                };
              });
            })
            .catch((error) => { console.error(error); if (!disposed) set({ agentSession: null }); })
            .finally(() => { if (!disposed) set({ agentSessionLoadingKey: null }); });
        }
      })
      .catch((error) => { console.error(error); if (!disposed) set({ agentSessionHistory: [] }); })
      .finally(() => { if (!disposed) set({ agentSessionHistoryLoadingKey: null }); });
    return () => { disposed = true; };
  },

  runAgentAnalysis: async () => {
    const { agentSession, agentPrompt, agentProvider, agentModel } = get();
    let targetSessionId = agentSession?.session?.id ?? null;
    // Capture pending images from the *current* session bucket. We resolve the
    // bucket again after possibly creating a new session, so that pending images
    // queued under the "__new__" placeholder are migrated to the new session id.
    const initialBucketKey = pendingImagesKey(targetSessionId);
    let idCounter = 0;
    const nextId = () => { idCounter += 1; return -(Date.now() * 100 + idCounter); };

    try {
      if (!targetSessionId) {
        const created = await createAgentSession({ provider: agentProvider, model: agentModel });
        targetSessionId = created.session?.id ?? null;
        if (!targetSessionId) throw new Error('agent session create failed');
        const createdSessionId = targetSessionId;
        set((s) => {
          const agentSessionById = cacheSession(s.agentSessionById, created);
          const runStateBySessionId = mergeHistoryRuns(created.history.sessions, {
            ...s.runStateBySessionId,
            [createdSessionId]: mergeRunPayload(s.runStateBySessionId[createdSessionId], createdSessionId, created.run),
          });
          // Migrate pending images from the placeholder bucket ("__new__") to
          // the freshly-created session id.
          const pendingImagesBySessionId = { ...s.pendingImagesBySessionId };
          const placeholderBucket = pendingImagesBySessionId[NEW_SESSION_PENDING_KEY];
          if (placeholderBucket && placeholderBucket.length > 0) {
            pendingImagesBySessionId[createdSessionId] = placeholderBucket;
            delete pendingImagesBySessionId[NEW_SESSION_PENDING_KEY];
          }
          const next = {
            ...s,
            agentSessionById,
            runStateBySessionId,
            agentSessionHistory: created.history.sessions,
            activeAgentSessionId: createdSessionId,
            pendingImagesBySessionId,
          };
          return {
            agentSessionById,
            runStateBySessionId,
            agentSessionHistory: created.history.sessions,
            activeAgentSessionId: createdSessionId,
            pendingImagesBySessionId,
            ...activeFields(next),
          };
        });
      }
      const runSessionId = targetSessionId;
      // Drain images from the bucket that now matches this run.
      const bucketKey = pendingImagesKey(runSessionId);
      const bucketImages = get().pendingImagesBySessionId[bucketKey] ?? get().pendingImagesBySessionId[initialBucketKey] ?? [];
      const imagesToSend = bucketImages.length > 0 ? [...bucketImages] : undefined;
      if (imagesToSend) {
        set((s) => {
          const pendingImagesBySessionId = { ...s.pendingImagesBySessionId };
          delete pendingImagesBySessionId[bucketKey];
          delete pendingImagesBySessionId[initialBucketKey];
          const next = { ...s, pendingImagesBySessionId };
          return { pendingImagesBySessionId, ...activeFields(next) };
        });
      }
      if (get().runStateBySessionId[runSessionId]?.status === 'running') return;
      // Allow image-only sends: when the user pastes/drops a screenshot and
      // hits Enter without any text, fill in a default prompt so the model
      // gets an instruction to act on. Mirrors what users would type by hand.
      const trimmedPrompt = agentPrompt.trim();
      const prompt = trimmedPrompt.length > 0
        ? agentPrompt
        : (imagesToSend && imagesToSend.length > 0 ? '分析这张图片' : agentPrompt);
      // Bail out if there's nothing to send at all.
      if (prompt.trim().length === 0 && !imagesToSend) return;
      set((s) => {
        const createdAt = new Date().toISOString();
        const optimisticUserMessage: AgentMessage = {
          id: nextId(),
          sessionId: runSessionId,
          role: 'user',
          content: prompt,
          createdAt,
          metadata: imagesToSend ? { images: imagesToSend } : null,
          error: null,
        };
        const agentSessionById = appendSessionMessage(s, runSessionId, optimisticUserMessage);
        const runningRun = {
          ...idleRun(runSessionId),
          status: 'running' as const,
          pendingToolCalls: new Set<string>(),
        };
        const runStateBySessionId = { ...s.runStateBySessionId, [runSessionId]: runningRun };
        const draftBySessionId = { ...s.draftBySessionId, [runSessionId]: '' };
        const agentSessionHistory = upsertOptimisticSessionSummary(
          s.agentSessionHistory,
          agentSessionById[runSessionId],
          prompt,
          createdAt,
          runningRun,
        );
        const next = { ...s, agentSessionById, runStateBySessionId, draftBySessionId, agentSessionHistory };
        return { agentSessionById, runStateBySessionId, draftBySessionId, agentSessionHistory, ...activeFields(next) };
      });

      let streamingContent = '';

      await streamAgentMessage(
        runSessionId,
        prompt,
        agentSession?.session?.runtime === 'claude-code'
          ? { images: imagesToSend }
          : { provider: agentProvider, model: agentModel, images: imagesToSend },
        (envelope) => {
          const sessionId = envelope.sessionId || runSessionId;
          const event = envelope.event;
          if (!event) return;

          if (event.type === 'message_start') {
            const raw = event.message;
            if (raw.role === 'assistant') {
              streamingContent = '';
              set({ streamingMessage: {
                id: nextId(),
                sessionId,
                role: 'assistant',
                content: '',
                createdAt: raw.createdAt ?? new Date().toISOString(),
                metadata: null,
                error: null,
              }});
            }
            return;
          }

          if (event.type === 'message_update') {
            const delta = event.delta ?? '';
            if (delta) {
              streamingContent += delta;
              set((s) => ({
                streamingMessage: s.streamingMessage
                  ? { ...s.streamingMessage, content: streamingContent }
                  : s.streamingMessage,
              }));
            }
            return;
          }

          if (event.type === 'message_end') {
            const raw = event.message;
            const isUserMessage = (raw.role ?? 'assistant') === 'user';
            const message: AgentMessage = {
              id: nextId(),
              sessionId,
              role: raw.role ?? 'assistant',
              content: raw.content ?? '',
              createdAt: raw.createdAt ?? new Date().toISOString(),
              metadata: raw.metadata ?? null,
              error: raw.error ?? null,
            };
            set((s) => {
              const agentSessionById = appendSessionMessage(s, sessionId, message);
              const previous = s.runStateBySessionId[sessionId] ?? idleRun(sessionId);
              const runStateBySessionId = replaceRunState(
                s.runStateBySessionId,
                sessionId,
                { ...previous, status: 'running', runId: envelope.runId, lastSeq: envelope.seq },
              );
              const clearStreaming = raw.role === 'assistant';
              // A confirmed user message means the backend just injected a
              // queued steering message into the transcript — drop it from the
              // pending region now that it lives in `messages`.
              const queuedSteeringBySessionId = isUserMessage
                ? removeQueuedSteering(s.queuedSteeringBySessionId, sessionId, message.content)
                : s.queuedSteeringBySessionId;
              const next = { ...s, agentSessionById, runStateBySessionId, queuedSteeringBySessionId };
              return {
                agentSessionById,
                runStateBySessionId,
                queuedSteeringBySessionId,
                ...(clearStreaming ? { streamingMessage: null } : {}),
                ...activeFields(next),
              };
            });
            return;
          }

          if (event.type === 'tool_execution_start') {
            set((s) => {
              const previous = s.runStateBySessionId[sessionId] ?? idleRun(sessionId);
              const pendingToolCalls = new Set(previous.pendingToolCalls);
              pendingToolCalls.add(event.toolCall.id);
              const runStateBySessionId = replaceRunState(
                s.runStateBySessionId,
                sessionId,
                { ...previous, status: 'running', runId: envelope.runId, lastSeq: envelope.seq, pendingToolCalls },
              );
              const next = { ...s, runStateBySessionId };
              return { runStateBySessionId, ...activeFields(next) };
            });
            return;
          }

          if (event.type === 'tool_execution_end') {
            const callId = String(event.toolResult?.callId ?? event.toolCall?.id ?? '');
            set((s) => {
              const previous = s.runStateBySessionId[sessionId] ?? idleRun(sessionId);
              const pendingToolCalls = new Set(previous.pendingToolCalls);
              if (callId) pendingToolCalls.delete(callId);
              const runStateBySessionId = replaceRunState(
                s.runStateBySessionId,
                sessionId,
                { ...previous, runId: envelope.runId, lastSeq: envelope.seq, pendingToolCalls },
              );
              const next = { ...s, runStateBySessionId };
              return { runStateBySessionId, ...activeFields(next) };
            });
            return;
          }

          if (event.type === 'agent_end') {
            const totalTokens = typeof event.totalTokens === 'number' ? event.totalTokens : 0;
            const promptTokens = event.promptTokens ?? 0;
            const stats = event.sessionStats ?? null;
            set((s) => {
              const previous = s.runStateBySessionId[sessionId] ?? idleRun(sessionId);
              const runStateBySessionId = replaceRunState(
                s.runStateBySessionId,
                sessionId,
                {
                  ...previous,
                  runId: envelope.runId,
                  lastSeq: envelope.seq,
                  contextUsage: { promptTokens, totalTokens },
                  sessionStats: stats,
                },
              );
              // The run is over: any steering still queued for this session was
              // never injected, so clear its pending region.
              const queuedSteeringBySessionId = s.queuedSteeringBySessionId[sessionId]?.length
                ? { ...s.queuedSteeringBySessionId, [sessionId]: [] }
                : s.queuedSteeringBySessionId;
              const next = { ...s, runStateBySessionId, queuedSteeringBySessionId, streamingMessage: null };
              return { runStateBySessionId, queuedSteeringBySessionId, streamingMessage: null, ...activeFields(next) };
            });
            return;
          }

          if (event.type === 'session_update') {
            useMarketStore.getState().setState(event.state);
            set((s) => {
              const agentSessionById = cacheSession(s.agentSessionById, event.session);
              const runStateBySessionId = mergeHistoryRuns(event.history.sessions, {
                ...s.runStateBySessionId,
                [sessionId]: mergeRunPayload(s.runStateBySessionId[sessionId], sessionId, event.session.run),
              });
              const next = { ...s, agentSessionById, runStateBySessionId, agentSessionHistory: event.history.sessions };
              return { agentSessionById, runStateBySessionId, agentSessionHistory: event.history.sessions, ...activeFields(next) };
            });
            return;
          }

          if (event.type === 'error') {
            set((s) => {
              const message: AgentMessage = {
                id: nextId(),
                sessionId,
                role: 'assistant',
                content: event.error,
                createdAt: new Date().toISOString(),
                metadata: null,
                error: event.error,
              };
              const agentSessionById = appendSessionMessage(s, sessionId, message);
              const previous = s.runStateBySessionId[sessionId] ?? idleRun(sessionId);
              const runStateBySessionId = replaceRunState(
                s.runStateBySessionId,
                sessionId,
                { ...previous, status: 'error', error: event.error, runId: envelope.runId, lastSeq: envelope.seq },
              );
              const next = { ...s, agentSessionById, runStateBySessionId };
              return { agentSessionById, runStateBySessionId, streamingMessage: null, ...activeFields(next) };
            });
          }
        },
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : 'agent analysis failed';
      if (targetSessionId) {
        const errorSessionId = targetSessionId;
        set((s) => {
          const errorMessage: AgentMessage = {
            id: nextId(),
            sessionId: errorSessionId,
            role: 'assistant',
            content: message,
            createdAt: new Date().toISOString(),
            metadata: null,
            error: message,
          };
          const agentSessionById = appendSessionMessage(s, errorSessionId, errorMessage);
          const previous = s.runStateBySessionId[errorSessionId] ?? idleRun(errorSessionId);
          const runStateBySessionId = replaceRunState(
            s.runStateBySessionId,
            errorSessionId,
            { ...previous, status: 'error', error: message, pendingToolCalls: new Set<string>() },
          );
          const next = { ...s, agentSessionById, runStateBySessionId };
          return { agentSessionById, runStateBySessionId, streamingMessage: null, ...activeFields(next) };
        });
      }
      console.error(error);
    } finally {
      if (targetSessionId) {
        const finishedSessionId = targetSessionId;
        set((s) => {
          const previous = s.runStateBySessionId[finishedSessionId] ?? idleRun(finishedSessionId);
          const status = previous.status === 'error' ? 'error' : 'idle';
          const runStateBySessionId = replaceRunState(
            s.runStateBySessionId,
            finishedSessionId,
            { ...previous, status, pendingToolCalls: new Set<string>() },
          );
          const next = { ...s, runStateBySessionId };
          return { runStateBySessionId, streamingMessage: null, ...activeFields(next) };
        });
      }
    }
  },

  steerAgent: async () => {
    const { activeAgentSessionId, agentPrompt, runStateBySessionId } = get();
    if (!activeAgentSessionId) return;
    const sessionId = activeAgentSessionId;
    const run = runStateBySessionId[sessionId];
    if (run?.status !== 'running') return;
    const prompt = agentPrompt.trim();
    if (!prompt) return;

    // Optimistically add to the fixed pending region (never spliced into
    // `messages`, so its position stays stable while the agent streams) and
    // clear the input immediately.
    const queued: QueuedSteeringMessage = {
      id: `steer-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      content: prompt,
      createdAt: new Date().toISOString(),
    };
    set((s) => {
      const queuedSteeringBySessionId = {
        ...s.queuedSteeringBySessionId,
        [sessionId]: [...(s.queuedSteeringBySessionId[sessionId] ?? []), queued],
      };
      const draftBySessionId = { ...s.draftBySessionId, [sessionId]: '' };
      const next = { ...s, draftBySessionId, queuedSteeringBySessionId };
      // activeFields derives `agentPrompt` from the (now-cleared) draft.
      return { draftBySessionId, queuedSteeringBySessionId, ...activeFields(next) };
    });

    try {
      await steerAgentSession(sessionId, prompt);
    } catch (error) {
      console.error('steer failed:', error);
      // Roll back the optimistic pending entry by its stable id.
      set((s) => {
        const queue = s.queuedSteeringBySessionId[sessionId];
        if (!queue) return {};
        const queuedSteeringBySessionId = {
          ...s.queuedSteeringBySessionId,
          [sessionId]: queue.filter((item) => item.id !== queued.id),
        };
        const next = { ...s, queuedSteeringBySessionId };
        return { queuedSteeringBySessionId, ...activeFields(next) };
      });
    }
  },

  abortAgent: async () => {
    const { activeAgentSessionId, runStateBySessionId } = get();
    if (!activeAgentSessionId) return;
    const run = runStateBySessionId[activeAgentSessionId];
    if (run?.status !== 'running') return;
    try {
      await abortAgentSession(activeAgentSessionId);
    } catch (error) {
      console.error('abort failed:', error);
    }
  },

  resetAgentConversation: async (agentId = 'default') => {
    if (get().agentSessionActionKey) return;
    const actionKey = 'new';
    set({ agentSessionActionKey: actionKey });
    try {
      const payload = await createAgentSession({ agentId });
      const sessionId = payload.session?.id ?? null;
      set((s) => {
        const agentSessionById = cacheSession(s.agentSessionById, payload);
        const runStateBySessionId = sessionId
          ? {
              ...mergeHistoryRuns(payload.history.sessions, s.runStateBySessionId),
              [sessionId]: mergeRunPayload(s.runStateBySessionId[sessionId], sessionId, payload.run),
            }
          : mergeHistoryRuns(payload.history.sessions, s.runStateBySessionId);
        const draftBySessionId = sessionId ? { ...s.draftBySessionId, [sessionId]: '' } : s.draftBySessionId;
        const next = {
          ...s,
          agentSessionById,
          runStateBySessionId,
          draftBySessionId,
          agentSessionHistory: payload.history.sessions,
          activeAgentSessionId: sessionId,
        };
        return {
          agentSessionById,
          runStateBySessionId,
          draftBySessionId,
          agentSessionHistory: payload.history.sessions,
          activeAgentSessionId: sessionId,
          ...activeFields(next),
        };
      });
    } catch (error) {
      console.error(error);
    } finally {
      set((s) => ({ agentSessionActionKey: s.agentSessionActionKey === actionKey ? null : s.agentSessionActionKey }));
    }
  },

  resumeAgentConversation: async (sessionId) => {
    if (get().agentSessionActionKey) return;
    if (get().activeAgentSessionId === sessionId) return;
    if (get().agentSessionById[sessionId]) {
      set((s) => {
        const next = { ...s, activeAgentSessionId: sessionId };
        return {
          activeAgentSessionId: sessionId,
          ...sessionProviderModel(s.agentSessionById[sessionId]),
          ...activeFields(next),
        };
      });
      return;
    }
    const actionKey = `resume:${sessionId}`;
    set({ agentSessionActionKey: actionKey });
    try {
      const payload = await fetchAgentSession(sessionId);
      set((s) => {
        const agentSessionById = cacheSession(s.agentSessionById, payload);
        const runStateBySessionId = {
          ...s.runStateBySessionId,
          [sessionId]: mergeRunPayload(s.runStateBySessionId[sessionId], sessionId, payload.run),
        };
        const next = {
          ...s,
          agentSessionById,
          runStateBySessionId,
          activeAgentSessionId: sessionId,
        };
        return {
          agentSessionById,
          runStateBySessionId,
          activeAgentSessionId: sessionId,
          ...sessionProviderModel(payload),
          ...activeFields(next),
        };
      });
    } catch (error) {
      console.error(error);
    } finally {
      set((s) => ({ agentSessionActionKey: s.agentSessionActionKey === actionKey ? null : s.agentSessionActionKey }));
    }
  },

  deleteAgentConversation: async (sessionId) => {
    if (get().agentSessionActionKey) return;
    if (get().runStateBySessionId[sessionId]?.status === 'running') return;
    const actionKey = `delete:${sessionId}`;
    set({ agentSessionActionKey: actionKey });
    try {
      const payload = await deleteAgentSessionById(sessionId);
      useMarketStore.getState().setState(payload.state);
      set((s) => {
        const agentSessionById = { ...s.agentSessionById };
        delete agentSessionById[sessionId];
        const runStateBySessionId = { ...mergeHistoryRuns(payload.history.sessions, s.runStateBySessionId) };
        delete runStateBySessionId[sessionId];
        const draftBySessionId = { ...s.draftBySessionId };
        delete draftBySessionId[sessionId];
        const queuedSteeringBySessionId = { ...s.queuedSteeringBySessionId };
        delete queuedSteeringBySessionId[sessionId];
        const activeAgentSessionId = s.activeAgentSessionId === sessionId
          ? payload.history.sessions[0]?.id ?? null
          : s.activeAgentSessionId;
        const next = {
          ...s,
          agentSessionById,
          runStateBySessionId,
          draftBySessionId,
          queuedSteeringBySessionId,
          agentSessionHistory: payload.history.sessions,
          activeAgentSessionId,
        };
        return {
          agentSessionById,
          runStateBySessionId,
          draftBySessionId,
          queuedSteeringBySessionId,
          agentSessionHistory: payload.history.sessions,
          activeAgentSessionId,
          ...activeFields(next),
        };
      });
    } catch (error) {
      console.error(error);
    } finally {
      set((s) => ({ agentSessionActionKey: s.agentSessionActionKey === actionKey ? null : s.agentSessionActionKey }));
    }
  },
}));
