import { create } from 'zustand';
import type {
  AgentContextUsage,
  AgentMessage,
  AgentModelOption,
  AgentSessionResponse,
  AgentSessionRun,
  AgentSessionSummary,
  AgentToolCall,
} from '../types';
import {
  createAgentSession,
  deleteAgentSessionById,
  fetchAgentSession,
  fetchAgentSessions,
  fetchProviderModels,
  streamAgentMessage,
} from '../api';
import { AGENT_PROVIDER_OPTIONS } from '../constants';
import { streamMessageToAgentMessage, upsertAgentMessage } from '../utils';
import {
  STREAM_COMMIT_TICK_MS,
  StreamingMessageController,
  type StreamingRawMessage,
} from './streamingController';
import { useMarketStore } from './marketStore';

type ContextUsage = AgentContextUsage | null;

interface SessionRunProjection extends AgentSessionRun {
  pendingToolCalls: Set<string>;
  contextUsage: ContextUsage;
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
  activeAgentSessionId: string | null;
  agentSessionById: Record<string, AgentSessionResponse>;
  runStateBySessionId: Record<string, SessionRunProjection>;
  draftBySessionId: Record<string, string>;

  setAgentSession: (session: AgentSessionResponse | null) => void;
  setAgentSessionHistory: (history: AgentSessionSummary[]) => void;
  setAgentPrompt: (prompt: string) => void;
  setAgentProvider: (provider: string) => void;
  setAgentModel: (model: string) => void;
  setModelCache: (updater: (prev: Record<string, AgentModelOption[]>) => Record<string, AgentModelOption[]>) => void;
  changeProviderModel: (provider: string, defaultModel: string) => void;

  initSessions: () => () => void;
  syncProviderModel: (profiles: Record<string, { enabled: boolean; models: string[]; modelEfforts: Record<string, string> }>) => void;
  fetchModelsForEnabledProviders: (profiles: Record<string, { enabled: boolean; models: string[]; modelEfforts: Record<string, string> }>) => void;
  runAgentAnalysis: () => Promise<void>;
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
  return { session: summary, messages: [], contextUsage: summary.contextUsage ?? null, run: summary.run };
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
  'agentSession' | 'agentPrompt' | 'pendingToolCalls' | 'contextUsage' | 'agentBusyKey'
> {
  const activeId = state.activeAgentSessionId;
  const run = activeId ? state.runStateBySessionId[activeId] : undefined;
  const session = visibleSession(state);
  return {
    agentSession: session,
    agentPrompt: activeId ? state.draftBySessionId[activeId] ?? '' : '',
    pendingToolCalls: new Set(run?.pendingToolCalls ?? []),
    contextUsage: run?.contextUsage ?? session?.contextUsage ?? null,
    agentBusyKey: activeId && run?.status === 'running' ? activeId : null,
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

function setSessionMessage(
  state: AgentState,
  sessionId: string,
  message: AgentMessage,
): Record<string, AgentSessionResponse> {
  const session = responseForSession(state, sessionId);
  const messages = message.role === 'user' && message.id > 0
    ? session.messages.filter((item) => !(
        item.id < 0 &&
        item.role === 'user' &&
        item.content === message.content
      ))
    : session.messages;
  return {
    ...state.agentSessionById,
    [sessionId]: {
      ...session,
      messages: upsertAgentMessage(messages, message),
    },
  };
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

function latestAssistantController(
  controllers: Map<string, StreamingMessageController>,
  sessionId: string,
): StreamingMessageController | null {
  const values = Array.from(controllers.values()).reverse();
  return values.find((controller) => controller.sessionId === sessionId && controller.role === 'assistant') ?? null;
}

export const useAgentStore = create<AgentState>((set, get) => ({
  agentSession: null,
  agentSessionHistory: [],
  agentSessionLoadingKey: null,
  agentSessionHistoryLoadingKey: null,
  agentSessionActionKey: null,
  agentBusyKey: null,
  agentPrompt: '',
  agentProvider: AGENT_PROVIDER_OPTIONS[0].provider,
  agentModel: AGENT_PROVIDER_OPTIONS[0].defaultModel,
  pendingToolCalls: new Set(),
  modelCache: {},
  contextUsage: null,
  activeAgentSessionId: null,
  agentSessionById: {},
  runStateBySessionId: {},
  draftBySessionId: {},

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
  setAgentProvider: (provider) => set({ agentProvider: provider }),
  setAgentModel: (model) => set({ agentModel: model }),
  setModelCache: (updater) => set((s) => ({ modelCache: updater(s.modelCache) })),
  changeProviderModel: (provider, defaultModel) => set({ agentProvider: provider, agentModel: defaultModel }),

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
    const { agentSession, agentPrompt, agentProvider, agentModel } = get();
    let targetSessionId = agentSession?.session?.id ?? null;
    const messageIds = new Map<string, number>();
    const streamControllers = new Map<string, StreamingMessageController>();
    let streamFlushTimer: ReturnType<typeof setTimeout> | null = null;

    const clearStreamFlushTimer = () => {
      if (streamFlushTimer !== null) {
        clearTimeout(streamFlushTimer);
        streamFlushTimer = null;
      }
    };

    const resolveFallbackId = (raw: StreamingRawMessage) => {
      const clientId = raw.clientId;
      let fallbackId = typeof raw.id === 'number' ? raw.id : 0;
      if (!fallbackId) {
        if (clientId && messageIds.has(clientId)) {
          fallbackId = messageIds.get(clientId) ?? 0;
        } else {
          fallbackId = -Date.now() - messageIds.size;
          if (clientId) messageIds.set(clientId, fallbackId);
        }
      }
      return fallbackId;
    };

    const flushStreamQueues = (force = false) => {
      clearStreamFlushTimer();
      const now = Date.now();
      const drained = Array.from(streamControllers.values())
        .map((controller) => ({ controller, message: controller.drain(now, force) }))
        .filter((item): item is { controller: StreamingMessageController; message: AgentMessage } => item.message !== null);

      if (drained.length > 0) {
        set((s) => {
          let agentSessionById = s.agentSessionById;
          let runStateBySessionId = s.runStateBySessionId;
          for (const { controller, message } of drained) {
            agentSessionById = setSessionMessage({ ...s, agentSessionById }, controller.sessionId, message);
            const previous = runStateBySessionId[controller.sessionId] ?? idleRun(controller.sessionId);
            runStateBySessionId = replaceRunState(
              runStateBySessionId,
              controller.sessionId,
              { ...previous, status: 'running', runId: controller.runId, lastSeq: controller.lastSeq },
            );
          }
          const next = { ...s, agentSessionById, runStateBySessionId };
          return { agentSessionById, runStateBySessionId, ...activeFields(next) };
        });
      }

      if (Array.from(streamControllers.values()).some((controller) => controller.hasQueuedChunks())) {
        streamFlushTimer = setTimeout(() => flushStreamQueues(), STREAM_COMMIT_TICK_MS);
      }
    };

    const scheduleStreamFlush = () => {
      if (streamFlushTimer !== null) return;
      streamFlushTimer = setTimeout(() => flushStreamQueues(), STREAM_COMMIT_TICK_MS);
    };

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
          id: -Date.now(),
          sessionId: runSessionId,
          role: 'user',
          content: prompt,
          createdAt,
          metadata: null,
          error: null,
        };
        const agentSessionById = setSessionMessage(s, runSessionId, optimisticUserMessage);
        const runningRun = {
          ...idleRun(runSessionId),
          status: 'running' as const,
          pendingToolCalls: new Set<string>(),
        };
        const runStateBySessionId = {
          ...s.runStateBySessionId,
          [runSessionId]: runningRun,
        };
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
      await streamAgentMessage(
        runSessionId,
        prompt,
        { provider: agentProvider, model: agentModel },
        (envelope) => {
          const sessionId = envelope.sessionId || runSessionId;
          const event = envelope.event;
          if (!event) return;
          if (event.type === 'tool_execution_start') {
            set((s) => {
              const previous = s.runStateBySessionId[sessionId] ?? idleRun(sessionId);
              const pendingToolCalls = new Set(previous.pendingToolCalls);
              pendingToolCalls.add(event.toolCall.id);
              const controller = latestAssistantController(streamControllers, sessionId);
              const agentSessionById = controller
                ? setSessionMessage(
                    s,
                    sessionId,
                    controller.addToolCall(event.toolCall as AgentToolCall, { runId: envelope.runId, seq: envelope.seq }),
                  )
                : s.agentSessionById;
              const runStateBySessionId = replaceRunState(
                s.runStateBySessionId,
                sessionId,
                { ...previous, status: 'running', runId: envelope.runId, lastSeq: envelope.seq, pendingToolCalls },
              );
              const next = { ...s, agentSessionById, runStateBySessionId };
              return { agentSessionById, runStateBySessionId, ...activeFields(next) };
            });
            return;
          }
          if (event.type === 'tool_execution_end') {
            set((s) => {
              const previous = s.runStateBySessionId[sessionId] ?? idleRun(sessionId);
              const pendingToolCalls = new Set(previous.pendingToolCalls);
              pendingToolCalls.delete(event.toolCall.id);
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
          if (event.type === 'message_start' || event.type === 'message_update' || event.type === 'message_end') {
            const raw = event.message;
            const clientId = raw.clientId;
            const fallbackId = resolveFallbackId(raw);
            const createdAt = new Date().toISOString();
            if (raw.role === 'assistant' && clientId) {
              let controller = streamControllers.get(clientId);
              if (!controller) {
                controller = new StreamingMessageController(
                  raw,
                  { id: fallbackId, sessionId, createdAt },
                  { runId: envelope.runId, seq: envelope.seq },
                );
                streamControllers.set(clientId, controller);
              } else {
                controller.update(raw, { runId: envelope.runId, seq: envelope.seq });
              }

              if (event.type === 'message_update') {
                if (controller.pushDelta(event.delta, raw.content)) {
                  scheduleStreamFlush();
                }
                return;
              }

              if (event.type === 'message_end') {
                const message = controller.finalize(raw, { runId: envelope.runId, seq: envelope.seq });
                streamControllers.delete(clientId);
                set((s) => {
                  const agentSessionById = setSessionMessage(s, sessionId, message);
                  const previous = s.runStateBySessionId[sessionId] ?? idleRun(sessionId);
                  const runStateBySessionId = replaceRunState(
                    s.runStateBySessionId,
                    sessionId,
                    { ...previous, status: 'running', runId: envelope.runId, lastSeq: envelope.seq },
                  );
                  const next = { ...s, agentSessionById, runStateBySessionId };
                  return { agentSessionById, runStateBySessionId, ...activeFields(next) };
                });
                if (!Array.from(streamControllers.values()).some((item) => item.hasQueuedChunks())) {
                  clearStreamFlushTimer();
                }
                return;
              }

              set((s) => {
                const message = controller.toMessage();
                const agentSessionById = setSessionMessage(s, sessionId, message);
                const previous = s.runStateBySessionId[sessionId] ?? idleRun(sessionId);
                const runStateBySessionId = replaceRunState(
                  s.runStateBySessionId,
                  sessionId,
                  { ...previous, status: 'running', runId: envelope.runId, lastSeq: envelope.seq },
                );
                const next = { ...s, agentSessionById, runStateBySessionId };
                return { agentSessionById, runStateBySessionId, ...activeFields(next) };
              });
              return;
            }
            set((s) => {
              const message = streamMessageToAgentMessage(raw, { id: fallbackId, sessionId, createdAt });
              const agentSessionById = setSessionMessage(s, sessionId, message);
              const previous = s.runStateBySessionId[sessionId] ?? idleRun(sessionId);
              const runStateBySessionId = replaceRunState(
                s.runStateBySessionId,
                sessionId,
                { ...previous, status: 'running', runId: envelope.runId, lastSeq: envelope.seq },
              );
              const next = { ...s, agentSessionById, runStateBySessionId };
              return { agentSessionById, runStateBySessionId, ...activeFields(next) };
            });
            return;
          }
          if (event.type === 'agent_end') {
            if (typeof event.totalTokens === 'number') {
              const totalTokens = event.totalTokens;
              const promptTokens = event.promptTokens ?? 0;
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
                  },
                );
                const next = { ...s, runStateBySessionId };
                return { runStateBySessionId, ...activeFields(next) };
              });
            }
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
            const createdAt = new Date().toISOString();
            set((s) => {
              const message: AgentMessage = {
                id: -Date.now(),
                sessionId,
                role: 'assistant',
                content: event.error,
                createdAt,
                metadata: null,
                error: event.error,
              };
              const agentSessionById = setSessionMessage(s, sessionId, message);
              const previous = s.runStateBySessionId[sessionId] ?? idleRun(sessionId);
              const runStateBySessionId = replaceRunState(
                s.runStateBySessionId,
                sessionId,
                { ...previous, status: 'error', error: event.error, runId: envelope.runId, lastSeq: envelope.seq },
              );
              const next = { ...s, agentSessionById, runStateBySessionId };
              return { agentSessionById, runStateBySessionId, ...activeFields(next) };
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
            id: -Date.now(),
            sessionId: errorSessionId,
            role: 'assistant',
            content: message,
            createdAt: new Date().toISOString(),
            metadata: null,
            error: message,
          };
          const agentSessionById = setSessionMessage(s, errorSessionId, errorMessage);
          const previous = s.runStateBySessionId[errorSessionId] ?? idleRun(errorSessionId);
          const runStateBySessionId = replaceRunState(
            s.runStateBySessionId,
            errorSessionId,
            { ...previous, status: 'error', error: message, pendingToolCalls: new Set<string>() },
          );
          const next = { ...s, agentSessionById, runStateBySessionId };
          return { agentSessionById, runStateBySessionId, ...activeFields(next) };
        });
      }
      console.error(error);
    } finally {
      clearStreamFlushTimer();
      streamControllers.clear();
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
          return { runStateBySessionId, ...activeFields(next) };
        });
      }
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
