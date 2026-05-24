import { create } from 'zustand';
import type {
  AgentContextUsage,
  AgentMessage,
  AgentModelOption,
  AgentSessionResponse,
  AgentSessionRun,
  AgentSessionStats,
  AgentSessionSummary,
} from '../types';
import {
  abortAgentSession,
  createAgentSession,
  deleteAgentSessionById,
  fetchAgentSession,
  fetchAgentSessions,
  fetchProviderModels,
  steerAgentSession,
  streamAgentMessage,
  type ImageAttachment,
} from '../api';
import { AGENT_PROVIDER_OPTIONS } from '../constants';

const STORAGE_KEY_PROVIDER = 'tradex-agent-provider';
const STORAGE_KEY_MODEL = 'tradex-agent-model';

function loadPersistedProvider(): string {
  try {
    const stored = localStorage.getItem(STORAGE_KEY_PROVIDER);
    if (stored && AGENT_PROVIDER_OPTIONS.some((o) => o.provider === stored)) return stored;
  } catch {}
  return AGENT_PROVIDER_OPTIONS[0].provider;
}

function loadPersistedModel(): string {
  try {
    const stored = localStorage.getItem(STORAGE_KEY_MODEL);
    if (stored) return stored;
  } catch {}
  return AGENT_PROVIDER_OPTIONS[0].defaultModel;
}

function persistProviderModel(provider: string, model: string): void {
  try {
    localStorage.setItem(STORAGE_KEY_PROVIDER, provider);
    localStorage.setItem(STORAGE_KEY_MODEL, model);
  } catch {}
}
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
  modelCache: Record<string, AgentModelOption[]>;
  contextUsage: ContextUsage;
  sessionStats: SessionStatsState;
  activeAgentSessionId: string | null;
  agentSessionById: Record<string, AgentSessionResponse>;
  runStateBySessionId: Record<string, SessionRunProjection>;
  draftBySessionId: Record<string, string>;
  /** The assistant message currently being streamed (pi-mono dual-zone pattern). */
  streamingMessage: AgentMessage | null;
  /** Number of steering messages queued and not yet processed by the agent. */
  steeringQueueCount: number;
  /** Pending image attachments to send with the next message. */
  pendingImages: ImageAttachment[];

  setAgentSession: (session: AgentSessionResponse | null) => void;
  setAgentSessionHistory: (history: AgentSessionSummary[]) => void;
  setAgentPrompt: (prompt: string) => void;
  setAgentProvider: (provider: string) => void;
  setAgentModel: (model: string) => void;
  addPendingImage: (image: ImageAttachment) => void;
  removePendingImage: (index: number) => void;
  clearPendingImages: () => void;
  setModelCache: (updater: (prev: Record<string, AgentModelOption[]>) => Record<string, AgentModelOption[]>) => void;
  changeProviderModel: (provider: string, defaultModel: string) => void;

  initSessions: () => () => void;
  syncProviderModel: (profiles: Record<string, { enabled: boolean; models: string[]; modelEfforts: Record<string, string> }>) => void;
  fetchModelsForEnabledProviders: (profiles: Record<string, { enabled: boolean; models: string[]; modelEfforts: Record<string, string> }>) => void;
  runAgentAnalysis: () => Promise<void>;
  steerAgent: () => Promise<void>;
  abortAgent: () => Promise<void>;
  resetAgentConversation: () => Promise<void>;
  resumeAgentConversation: (sessionId: string) => Promise<void>;
  deleteAgentConversation: (sessionId: string) => Promise<void>;
}

type ActiveMirrorSource = Pick<
  AgentState,
  'activeAgentSessionId' | 'agentSessionById' | 'agentSessionHistory' | 'runStateBySessionId' | 'draftBySessionId'
>;

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

function activeFields(state: ActiveMirrorSource): Pick<
  AgentState,
  'agentSession' | 'agentPrompt' | 'pendingToolCalls' | 'contextUsage' | 'sessionStats' | 'agentBusyKey'
> {
  const activeId = state.activeAgentSessionId;
  const run = activeId ? state.runStateBySessionId[activeId] : undefined;
  const session = visibleSession(state);
  return {
    agentSession: session,
    agentPrompt: activeId ? state.draftBySessionId[activeId] ?? '' : '',
    pendingToolCalls: new Set(run?.pendingToolCalls ?? []),
    contextUsage: run?.contextUsage ?? session?.contextUsage ?? null,
    sessionStats: run?.sessionStats ?? session?.sessionStats ?? null,
    agentBusyKey: activeId && run?.status === 'running' ? activeId : null,
  };
}

function appendSessionMessage(
  state: AgentState,
  sessionId: string,
  message: AgentMessage,
): Record<string, AgentSessionResponse> {
  const session = responseForSession(state, sessionId);
  // When backend confirms a steered user message, remove the optimistic queued placeholder
  const messages = message.role === 'user'
    ? session.messages.filter((item) => !(
        item.role === 'user' &&
        item.metadata?.queued === true &&
        item.content === message.content
      ))
    : session.messages;
  return {
    ...state.agentSessionById,
    [sessionId]: {
      ...session,
      messages: [...messages, message],
    },
  };
}

function cacheSession(
  cache: Record<string, AgentSessionResponse>,
  payload: AgentSessionResponse,
): Record<string, AgentSessionResponse> {
  const sessionId = payload.session?.id;
  return sessionId ? { ...cache, [sessionId]: payload } : cache;
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
  agentProvider: loadPersistedProvider(),
  agentModel: loadPersistedModel(),
  pendingToolCalls: new Set(),
  modelCache: {},
  contextUsage: null,
  sessionStats: null,
  activeAgentSessionId: null,
  agentSessionById: {},
  runStateBySessionId: {},
  draftBySessionId: {},
  streamingMessage: null,
  steeringQueueCount: 0,
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
    return { activeAgentSessionId, agentSessionById, runStateBySessionId, ...activeFields(next) };
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
    set({ agentProvider: provider });
    persistProviderModel(provider, get().agentModel);
  },
  setAgentModel: (model) => {
    set({ agentModel: model });
    persistProviderModel(get().agentProvider, model);
  },
  addPendingImage: (image) => set((s) => ({ pendingImages: [...s.pendingImages, image] })),
  removePendingImage: (index) => set((s) => ({ pendingImages: s.pendingImages.filter((_, i) => i !== index) })),
  clearPendingImages: () => set({ pendingImages: [] }),
  setModelCache: (updater) => set((s) => ({ modelCache: updater(s.modelCache) })),
  changeProviderModel: (provider, defaultModel) => {
    set({ agentProvider: provider, agentModel: defaultModel });
    persistProviderModel(provider, defaultModel);
  },

  syncProviderModel: (profiles) => {
    const { agentProvider, agentModel } = get();
    const currentProfile = profiles[agentProvider];
    if (currentProfile?.enabled && currentProfile.models?.length) {
      if (!currentProfile.models.includes(agentModel)) {
        set({ agentModel: currentProfile.models[0] });
      }
    } else {
      const firstEnabled = AGENT_PROVIDER_OPTIONS.find((o) => profiles[o.provider]?.enabled);
      if (firstEnabled) {
        const fp = profiles[firstEnabled.provider];
        set({
          agentProvider: firstEnabled.provider,
          agentModel: fp?.models?.[0] || firstEnabled.defaultModel,
        });
      }
    }
  },

  fetchModelsForEnabledProviders: (profiles) => {
    const { modelCache } = get();
    const enabledProviders = AGENT_PROVIDER_OPTIONS
      .filter((o) => profiles[o.provider]?.enabled)
      .map((o) => o.provider);
    for (const provider of enabledProviders) {
      if (modelCache[provider]?.length) continue;
      fetchProviderModels(provider)
        .then((payload) => {
          const visible = payload.models.filter((m) => m.supportedInApi && m.visibility !== 'hide');
          set((s) => ({ modelCache: { ...s.modelCache, [provider]: visible } }));
        })
        .catch(() => {});
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
          return {
            agentSessionById,
            agentSessionHistory: payload.sessions,
            runStateBySessionId,
            activeAgentSessionId: next.activeAgentSessionId,
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
                return { agentSessionById, runStateBySessionId, activeAgentSessionId: sessionId, ...activeFields(next) };
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
    const { agentSession, agentPrompt, agentProvider, agentModel, pendingImages } = get();
    const imagesToSend = pendingImages.length > 0 ? [...pendingImages] : undefined;
    if (pendingImages.length > 0) set({ pendingImages: [] });
    let targetSessionId = agentSession?.session?.id ?? null;
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
          const next = {
            ...s,
            agentSessionById,
            runStateBySessionId,
            agentSessionHistory: created.history.sessions,
            activeAgentSessionId: createdSessionId,
          };
          return {
            agentSessionById,
            runStateBySessionId,
            agentSessionHistory: created.history.sessions,
            activeAgentSessionId: createdSessionId,
            ...activeFields(next),
          };
        });
      }
      const runSessionId = targetSessionId;
      if (get().runStateBySessionId[runSessionId]?.status === 'running') return;
      const prompt = agentPrompt;
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
        { provider: agentProvider, model: agentModel, images: imagesToSend },
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
              // Decrement steering queue when a steered user message is confirmed by backend
              const steeringQueueCount = isUserMessage
                ? Math.max(0, s.steeringQueueCount - 1)
                : s.steeringQueueCount;
              const next = { ...s, agentSessionById, runStateBySessionId };
              return {
                agentSessionById,
                runStateBySessionId,
                steeringQueueCount,
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
              const next = { ...s, runStateBySessionId, streamingMessage: null };
              return { runStateBySessionId, streamingMessage: null, steeringQueueCount: 0, ...activeFields(next) };
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
    const run = runStateBySessionId[activeAgentSessionId];
    if (run?.status !== 'running') return;
    const prompt = agentPrompt.trim();
    if (!prompt) return;
    // Clear input and increment queue count immediately
    set((s) => ({
      agentPrompt: '',
      draftBySessionId: { ...s.draftBySessionId, [activeAgentSessionId]: '' },
      steeringQueueCount: s.steeringQueueCount + 1,
    }));
    // Add optimistic user message to transcript (shown greyed out as "queued")
    const optimisticMessage: AgentMessage = {
      id: -Date.now(),
      sessionId: activeAgentSessionId,
      role: 'user',
      content: prompt,
      createdAt: new Date().toISOString(),
      metadata: { queued: true },
      error: null,
    };
    set((s) => {
      const agentSessionById = appendSessionMessage(s, activeAgentSessionId, optimisticMessage);
      const next = { ...s, agentSessionById };
      return { agentSessionById, ...activeFields(next) };
    });
    try {
      await steerAgentSession(activeAgentSessionId, prompt);
    } catch (error) {
      console.error('steer failed:', error);
      set((s) => ({ steeringQueueCount: Math.max(0, s.steeringQueueCount - 1) }));
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

  resetAgentConversation: async () => {
    if (get().agentSessionActionKey) return;
    const { agentProvider, agentModel } = get();
    const actionKey = 'new';
    set({ agentSessionActionKey: actionKey });
    try {
      const payload = await createAgentSession({ provider: agentProvider, model: agentModel });
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
        return { activeAgentSessionId: sessionId, ...activeFields(next) };
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
        const activeAgentSessionId = s.activeAgentSessionId === sessionId
          ? payload.history.sessions[0]?.id ?? null
          : s.activeAgentSessionId;
        const next = {
          ...s,
          agentSessionById,
          runStateBySessionId,
          draftBySessionId,
          agentSessionHistory: payload.history.sessions,
          activeAgentSessionId,
        };
        return {
          agentSessionById,
          runStateBySessionId,
          draftBySessionId,
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
