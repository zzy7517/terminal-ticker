/** 管理 Agent 选择、Session 历史、流式消息和操作状态的 Zustand store。 */
import { chronologicalMessages } from '../chat/timeline';
import { create } from 'zustand';
import type {
  AgentDefinition,
  AgentDefinitionInput,
  AgentIdentityPatch,
  AgentMessage,
  AgentModelRegistry,
  AgentSessionResponse,
  AgentSessionSummary,
  MarketState,
  QueuedFollowUp,
} from '../types';
import {
  AgentStreamDisconnectError,
  createAgent,
  deleteAgent,
  deleteAgentSessionById,
  fetchAgentDirectMessages,
  fetchAgentModelRegistry,
  fetchAgents,
  fetchAgentSession,
  fetchAgentSessions,
  sendAgentDirectMessage,
  setDirectMessageReaction,
  streamAgentMessage,
  updateAgent,
  type ImageAttachment,
} from '../api';
import { randomAvatarSeed } from '../avatar';
import { useMarketStore } from './marketStore';
import { mergeFollowUps, shouldAutoRunFollowUps, validateFollowUpImages } from '../utils/followUpQueue';
import { createDirectMessagesSlice, type DirectMessagesSlice } from './agent/directMessages';
import {
  loadPersistedModels,
  loadPersistedProvider,
  persistProviderModel,
  registrySelection,
  sessionProviderModel,
} from './agent/modelPreferences';
import {
  activeFields,
  appendSessionMessage,
  cacheSession,
  idleRun,
  mergeHistoryRuns,
  mergeRunPayload,
  pendingImagesKey,
  replaceRunState,
  selectionUpdate,
  sessionFromSummary,
  upsertOptimisticSessionSummary,
  type AgentSelection,
  type SessionRunProjection,
} from './agent/sessionProjection';
import { applyAgentStreamEvent, type AgentStreamAction } from './agent/streamProjection';

const initialProvider = loadPersistedProvider();
const initialModels = loadPersistedModels();

export interface AgentState extends DirectMessagesSlice {
  agents: AgentDefinition[];
  selectedAgentId: string;
  agentSession: AgentSessionResponse | null;
  agentSessionHistory: AgentSessionSummary[];
  agentSessionLoadingKey: string | null;
  agentSessionHistoryLoadingKey: string | null;
  agentChatActionKey: string | null;
  agentBusyKey: string | null;
  agentPrompt: string;
  agentProvider: string;
  agentModel: string;
  pendingToolCalls: Set<string>;
  modelRegistry: AgentModelRegistry | null;
  modelRegistryLoading: boolean;
  activeAgentSessionId: string | null;
  agentSessionById: Record<string, AgentSessionResponse>;
  runStateBySessionId: Record<string, SessionRunProjection>;
  draftBySessionId: Record<string, string>;
  streamingMessageBySessionId: Record<string, AgentMessage>;
  /** The assistant message currently being streamed (dual-zone pattern). */
  streamingMessage: AgentMessage | null;
  /**
   * Steering messages sent to a running agent but not yet confirmed by the
   * backend, keyed by session id. Rendered in a fixed pending region below the
   * transcript instead of being spliced into `messages`, so their position
   * stays stable while the agent streams.
   */
  queuedFollowUpsBySessionId: Record<string, QueuedFollowUp[]>;
  queuedFollowUps: QueuedFollowUp[];
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
  addPendingImage: (image: ImageAttachment) => void;
  removePendingImage: (index: number) => void;
  clearPendingImages: () => void;

  initSessions: () => () => void;
  refreshModelRegistry: () => Promise<void>;
  selectAgent: (agentId: string) => Promise<void>;
  /** Refresh the agents list from the Agent definition store. */
  refreshAgents: () => Promise<AgentDefinition[]>;
  /** Patch identity fields (name / signature / avatarSeed) and refresh the agents list. */
  patchAgent: (agentId: string, patch: AgentIdentityPatch) => Promise<AgentDefinition>;
  /** Mint a new avatar seed and persist it. */
  rerollAgentAvatar: (agentId: string) => Promise<AgentDefinition>;
  /** Create an Agent definition and refresh the agents list. */
  createAgentDefinition: (input: AgentDefinitionInput) => Promise<AgentDefinition>;
  /** Update an Agent definition (full editor patch) and refresh the agents list. */
  updateAgentDefinition: (agentId: string, patch: Partial<AgentDefinitionInput>) => Promise<AgentDefinition>;
  /** Delete an Agent definition and refresh the agents list. */
  removeAgentDefinition: (agentId: string) => Promise<AgentDefinition[]>;
  runAgentAnalysis: (sessionId?: string, options?: { includeDraft?: boolean; skillNames?: string[] }) => Promise<void>;
  removeFollowUp: (id: string) => void;
  clearFollowUps: () => void;
  resumeAgentConversation: (sessionId: string) => Promise<void>;
  deleteAgentConversation: (sessionId: string) => Promise<void>;
}

/**
 * agentStore 的全部外部依赖（API、跨 store 写入、时钟）。
 * 默认实现指向真实模块；测试用 createAgentStore({ ...fakes }) 注入替身。
 * 形状对齐 originStore 的 OriginStoreDependencies。
 */
export interface AgentStoreDependencies {
  fetchAgents: typeof fetchAgents;
  createAgent: typeof createAgent;
  updateAgent: typeof updateAgent;
  deleteAgent: typeof deleteAgent;
  fetchAgentSessions: typeof fetchAgentSessions;
  fetchAgentSession: typeof fetchAgentSession;
  deleteAgentSessionById: typeof deleteAgentSessionById;
  fetchAgentDirectMessages: typeof fetchAgentDirectMessages;
  sendAgentDirectMessage: typeof sendAgentDirectMessage;
  setDirectMessageReaction: typeof setDirectMessageReaction;
  streamAgentMessage: typeof streamAgentMessage;
  fetchAgentModelRegistry: typeof fetchAgentModelRegistry;
  randomAvatarSeed: () => string;
  /** session_update / delete 时把行情快照写回 marketStore 的唯一出口。 */
  setMarketState: (state: MarketState) => void;
  /** 动态加载 DM workspace 编排（保持 agentStore ↔ chat 的循环隔离）。 */
  loadDirectMessageWorkspace: () => Promise<{
    bindSelectedDirectMessage: () => void;
    markDirectMessageReadIfActive: (agentId: string) => void;
  }>;
  /** ISO 时间戳时钟。 */
  now: () => string;
}

const defaultDependencies: AgentStoreDependencies = {
  fetchAgents,
  createAgent,
  updateAgent,
  deleteAgent,
  fetchAgentSessions,
  fetchAgentSession,
  deleteAgentSessionById,
  fetchAgentDirectMessages,
  sendAgentDirectMessage,
  setDirectMessageReaction,
  streamAgentMessage,
  fetchAgentModelRegistry,
  randomAvatarSeed,
  setMarketState: (state) => useMarketStore.getState().setState(state),
  loadDirectMessageWorkspace: () => import('../chat/directMessageWorkspace'),
  now: () => new Date().toISOString(),
};

export function createAgentStore(overrides: Partial<AgentStoreDependencies> = {}) {
  const deps: AgentStoreDependencies = { ...defaultDependencies, ...overrides };
  let modelRegistryRequest: Promise<AgentModelRegistry> | null = null;

  return create<AgentState>((set, get) => {
    /** 应用一个流事件归约结果，并统一补齐活动镜像字段。 */
    const dispatchStream = (action: AgentStreamAction) => {
      set((s) => {
        const update = applyAgentStreamEvent(s, action);
        if (!update) return {};
        const next = { ...s, ...update };
        return { ...update, ...activeFields(next) };
      });
    };

    return {
      ...createDirectMessagesSlice(set, get, deps),
      agents: [],
      selectedAgentId: 'default',
      agentSession: null,
      agentSessionHistory: [],
      agentSessionLoadingKey: null,
      agentSessionHistoryLoadingKey: null,
      agentChatActionKey: null,
      agentBusyKey: null,
      agentPrompt: '',
      agentProvider: initialProvider,
      agentModel: initialModels[initialProvider] ?? '',
      pendingToolCalls: new Set(),
      modelRegistry: null,
      modelRegistryLoading: false,
      activeAgentSessionId: null,
      agentSessionById: {},
      runStateBySessionId: {},
      draftBySessionId: {},
      streamingMessageBySessionId: {},
      streamingMessage: null,
      queuedFollowUpsBySessionId: {},
      queuedFollowUps: [],
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
      setAgentPrompt: (prompt) => set((s) => {
        const key = pendingImagesKey(s.activeAgentSessionId);
        const next = {
          ...s,
          draftBySessionId: { ...s.draftBySessionId, [key]: prompt },
        };
        return { draftBySessionId: next.draftBySessionId, ...activeFields(next) };
      }),
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
      // 从当前 Session 的 follow-up 队列移除指定项目。
      removeFollowUp: (id) => set((s) => {
        const sessionId = s.activeAgentSessionId;
        if (!sessionId) return s;
        const queue = s.queuedFollowUpsBySessionId[sessionId] ?? [];
        const queuedFollowUpsBySessionId = {
          ...s.queuedFollowUpsBySessionId,
          [sessionId]: queue.filter((item) => item.id !== id),
        };
        const next = { ...s, queuedFollowUpsBySessionId };
        return { queuedFollowUpsBySessionId, ...activeFields(next) };
      }),
      // 清空当前 Session 的全部 follow-up 项目。
      clearFollowUps: () => set((s) => {
        const sessionId = s.activeAgentSessionId;
        if (!sessionId || !s.queuedFollowUpsBySessionId[sessionId]?.length) return s;
        const queuedFollowUpsBySessionId = { ...s.queuedFollowUpsBySessionId, [sessionId]: [] };
        const next = { ...s, queuedFollowUpsBySessionId };
        return { queuedFollowUpsBySessionId, ...activeFields(next) };
      }),

      refreshModelRegistry: async () => {
        set({ modelRegistryLoading: true });
        try {
          modelRegistryRequest ??= deps.fetchAgentModelRegistry().finally(() => {
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

      selectAgent: async (agentId) => {
        if (get().agentChatActionKey) return;
        try {
          const [payload, agentPayload] = await Promise.all([
            deps.fetchAgentDirectMessages(agentId),
            deps.fetchAgents().catch((error) => {
              console.error('Agents refresh failed:', error);
              return null;
            }),
          ]);
          set((s) => {
            const directMessageIdByAgentId = {
              ...s.directMessageIdByAgentId,
              [agentId]: payload.target.directMessageId,
            };
            const directMessagesByAgentId = {
              ...s.directMessagesByAgentId,
              [agentId]: chronologicalMessages(payload.messages),
            };
            const activeAgentSessionId = s.agentSessionHistory.find((session) => session.agentId === agentId)?.id ?? null;
            return {
              ...(agentPayload ? { agents: agentPayload.agents } : {}),
              directMessageIdByAgentId,
              directMessagesByAgentId,
              ...selectionUpdate({ ...s, directMessageIdByAgentId, directMessagesByAgentId }, {
                selectedAgentId: agentId,
                activeAgentSessionId,
              }),
            };
          });
        } catch (error) {
          console.error('Agent Direct Messages fetch failed:', error);
        }
      },

      patchAgent: async (agentId, patch) => get().updateAgentDefinition(agentId, patch),

      rerollAgentAvatar: async (agentId) => get().patchAgent(agentId, { avatarSeed: deps.randomAvatarSeed() }),

      refreshAgents: async () => {
        const payload = await deps.fetchAgents();
        set({ agents: payload.agents });
        return payload.agents;
      },

      createAgentDefinition: async (input) => {
        const payload = await deps.createAgent(input);
        set({ agents: payload.agents });
        return payload.agent;
      },

      updateAgentDefinition: async (agentId, patch) => {
        const payload = await deps.updateAgent(agentId, patch);
        set({ agents: payload.agents });
        return payload.agent;
      },

      removeAgentDefinition: async (agentId) => {
        const payload = await deps.deleteAgent(agentId);
        set({ agents: payload.agents });
        return payload.agents;
      },

      initSessions: () => {
        let disposed = false;
        const key = 'global';
        set({ agentSessionHistoryLoadingKey: key });
        deps.fetchAgentSessions()
          .then(async (payload) => {
            if (disposed) return;
            const agentPayload = await deps.fetchAgents();
            const firstSummary = payload.sessions[0] ?? null;
            const selectedAgentId = firstSummary?.agentId ?? agentPayload.agents[0]?.id ?? 'default';
            const directMessages = await deps.fetchAgentDirectMessages(selectedAgentId).catch((error) => {
              console.error('Initial Agent Direct Messages fetch failed:', error);
              return null;
            });
            if (disposed) return;
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
              const initialSessionId = firstSummary?.id ?? null;
              const directMessageIdByAgentId = directMessages
                ? { ...s.directMessageIdByAgentId, [selectedAgentId]: directMessages.target.directMessageId }
                : s.directMessageIdByAgentId;
              const directMessagesByAgentId = directMessages
                ? { ...s.directMessagesByAgentId, [selectedAgentId]: chronologicalMessages(directMessages.messages) }
                : s.directMessagesByAgentId;
              const next = {
                ...s,
                agentSessionById,
                agentSessionHistory: payload.sessions,
                runStateBySessionId,
                activeAgentSessionId: s.activeAgentSessionId ?? initialSessionId,
                selectedAgentId,
                directMessageIdByAgentId,
                directMessagesByAgentId,
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
                agents: agentPayload.agents,
                selectedAgentId,
                directMessageIdByAgentId,
                directMessagesByAgentId,
                ...sessionProviderModel(activeSession),
                ...activeFields(next),
              };
            });
            // Bind Chat activeTarget + advance unread cursor for the preloaded DM.
            void deps.loadDirectMessageWorkspace().then(({ bindSelectedDirectMessage }) => {
              if (!disposed) bindSelectedDirectMessage();
            });
            const activeSessionId = get().activeAgentSessionId ?? firstSummary?.id ?? null;
            if (activeSessionId && !get().agentSessionById[activeSessionId]) {
              set({ agentSessionLoadingKey: key });
              deps.fetchAgentSession(activeSessionId)
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

      // Human → Agent composer: always Shared Message Fabric (text and/or images).
      // Session stream remains only for explicit requestedSessionId follow-up drains.
      runAgentAnalysis: async (requestedSessionId, options) => {
        const state = get();
        const includeDraft = options?.includeDraft !== false;
        if (!requestedSessionId) {
          const draftKey = pendingImagesKey(state.activeAgentSessionId);
          const agentPrompt = includeDraft ? state.draftBySessionId[draftKey] ?? state.agentPrompt : '';
          const images = includeDraft ? [...(state.pendingImagesBySessionId[draftKey] ?? [])] : [];
          const content = agentPrompt.trim() || (images.length > 0 ? '分析这张图片' : '');
          if (!content && images.length === 0) return;
          const imageError = validateFollowUpImages(images);
          if (imageError) {
            console.error(imageError);
            return;
          }
          try {
            await deps.sendAgentDirectMessage(
              state.selectedAgentId,
              content,
              images.length ? images : undefined,
              options?.skillNames,
            );
            set((s) => {
              const pendingImagesBySessionId = { ...s.pendingImagesBySessionId };
              delete pendingImagesBySessionId[draftKey];
              const draftBySessionId = { ...s.draftBySessionId, [draftKey]: '' };
              const next = { ...s, pendingImagesBySessionId, draftBySessionId };
              return { pendingImagesBySessionId, draftBySessionId, ...activeFields(next) };
            });
            await get().refreshAgentDirectMessages(state.selectedAgentId);
            const { markDirectMessageReadIfActive } = await deps.loadDirectMessageWorkspace();
            markDirectMessageReadIfActive(state.selectedAgentId);
          } catch (error) {
            console.error('Agent Direct Message send failed:', error);
          }
          return;
        }

        const agentPrompt = includeDraft
          ? state.draftBySessionId[requestedSessionId] ?? ''
          : '';
        const runSessionId = requestedSessionId;
        let drainedFollowUps: QueuedFollowUp[] = [];
        let restoredFollowUps = false;
        let runFailed = false;
        const bucketKey = pendingImagesKey(runSessionId);
        let idCounter = 0;
        const nextId = () => { idCounter += 1; return -(Date.now() * 100 + idCounter); };

        if (get().runStateBySessionId[runSessionId]?.status === 'running') {
          const images = [...(get().pendingImagesBySessionId[bucketKey] ?? [])];
          const content = agentPrompt.trim();
          if (!content && images.length === 0) return;
          const queued: QueuedFollowUp = {
            id: `follow-up-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            content,
            images,
            createdAt: deps.now(),
          };
          set((s) => {
            const queuedFollowUpsBySessionId = {
              ...s.queuedFollowUpsBySessionId,
              [runSessionId]: [...(s.queuedFollowUpsBySessionId[runSessionId] ?? []), queued],
            };
            const draftBySessionId = { ...s.draftBySessionId, [runSessionId]: '' };
            const pendingImagesBySessionId = { ...s.pendingImagesBySessionId };
            delete pendingImagesBySessionId[bucketKey];
            const next = { ...s, queuedFollowUpsBySessionId, draftBySessionId, pendingImagesBySessionId };
            return { queuedFollowUpsBySessionId, draftBySessionId, pendingImagesBySessionId, ...activeFields(next) };
          });
          return;
        }

        try {
          const bucketImages = includeDraft ? get().pendingImagesBySessionId[bucketKey] ?? [] : [];
          const queuedFollowUps = get().queuedFollowUpsBySessionId[runSessionId] ?? [];
          drainedFollowUps = queuedFollowUps;
          const mergedFollowUps = mergeFollowUps(queuedFollowUps, agentPrompt, bucketImages);
          const combinedImages = mergedFollowUps.images;
          const imageError = validateFollowUpImages(combinedImages);
          if (imageError) {
            set((s) => {
              const previous = s.runStateBySessionId[runSessionId] ?? idleRun(runSessionId);
              const runStateBySessionId = replaceRunState(s.runStateBySessionId, runSessionId, {
                ...previous,
                status: 'error',
                error: imageError,
              });
              const next = { ...s, runStateBySessionId };
              return { runStateBySessionId, ...activeFields(next) };
            });
            return;
          }
          const imagesToSend = combinedImages.length > 0 ? combinedImages : undefined;
          if (imagesToSend || queuedFollowUps.length > 0) {
            set((s) => {
              const pendingImagesBySessionId = { ...s.pendingImagesBySessionId };
              delete pendingImagesBySessionId[bucketKey];
              const queuedFollowUpsBySessionId = { ...s.queuedFollowUpsBySessionId, [runSessionId]: [] };
              const next = { ...s, pendingImagesBySessionId, queuedFollowUpsBySessionId };
              return { pendingImagesBySessionId, queuedFollowUpsBySessionId, ...activeFields(next) };
            });
          }
          if (get().runStateBySessionId[runSessionId]?.status === 'running') return;
          const combinedText = mergedFollowUps.prompt;
          const prompt = combinedText.length > 0
            ? combinedText
            : (imagesToSend && imagesToSend.length > 0 ? '分析这张图片' : agentPrompt);
          if (prompt.trim().length === 0 && !imagesToSend) return;
          set((s) => {
            const createdAt = deps.now();
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

          await deps.streamAgentMessage(
            runSessionId,
            prompt,
            { images: imagesToSend },
            (envelope) => {
              const sessionId = envelope.sessionId || runSessionId;
              const event = envelope.event;
              if (!event) return;

              switch (event.type) {
                case 'message_start': {
                  if (event.message.role !== 'assistant') return;
                  streamingContent = '';
                  dispatchStream({
                    type: 'message_start',
                    sessionId,
                    id: nextId(),
                    createdAt: event.message.createdAt ?? deps.now(),
                  });
                  return;
                }
                case 'message_update': {
                  const delta = event.delta ?? '';
                  if (!delta) return;
                  streamingContent += delta;
                  dispatchStream({ type: 'message_update', sessionId, content: streamingContent });
                  return;
                }
                case 'message_end': {
                  const raw = event.message;
                  dispatchStream({
                    type: 'message_end',
                    sessionId,
                    runId: envelope.runId,
                    seq: envelope.seq,
                    clearStreaming: raw.role === 'assistant',
                    message: {
                      id: nextId(),
                      sessionId,
                      role: raw.role ?? 'assistant',
                      content: raw.content ?? '',
                      createdAt: raw.createdAt ?? deps.now(),
                      metadata: raw.metadata ?? null,
                      error: raw.error ?? null,
                    },
                  });
                  return;
                }
                case 'tool_execution_start': {
                  dispatchStream({
                    type: 'tool_start',
                    sessionId,
                    toolCallId: event.toolCall.id,
                    runId: envelope.runId,
                    seq: envelope.seq,
                  });
                  return;
                }
                case 'tool_execution_end': {
                  dispatchStream({
                    type: 'tool_end',
                    sessionId,
                    callId: String(event.toolResult?.callId ?? event.toolCall?.id ?? ''),
                    runId: envelope.runId,
                    seq: envelope.seq,
                  });
                  return;
                }
                case 'agent_end': {
                  const unexpectedError = event.error || null;
                  if (unexpectedError) runFailed = true;
                  const restoreFollowUps = Boolean(unexpectedError) && !restoredFollowUps;
                  if (unexpectedError) restoredFollowUps = true;
                  dispatchStream({
                    type: 'agent_end',
                    sessionId,
                    error: unexpectedError,
                    runId: envelope.runId,
                    seq: envelope.seq,
                    drainedFollowUps,
                    restoreFollowUps,
                  });
                  return;
                }
                case 'session_update': {
                  deps.setMarketState(event.state);
                  dispatchStream({
                    type: 'session_update',
                    sessionId,
                    session: event.session,
                    history: event.history.sessions,
                  });
                  return;
                }
                case 'error': {
                  runFailed = true;
                  const restoreFollowUps = !restoredFollowUps;
                  restoredFollowUps = true;
                  dispatchStream({
                    type: 'stream_error',
                    sessionId,
                    error: event.error,
                    runId: envelope.runId,
                    seq: envelope.seq,
                    drainedFollowUps,
                    restoreFollowUps,
                    message: {
                      id: nextId(),
                      sessionId,
                      role: 'assistant',
                      content: event.error,
                      createdAt: deps.now(),
                      metadata: null,
                      error: event.error,
                    },
                  });
                  return;
                }
                default:
                  return;
              }
            },
          );
        } catch (error) {
          runFailed = true;
          const disconnected = error instanceof AgentStreamDisconnectError;
          const message = error instanceof Error ? error.message : 'agent analysis failed';
          const restoreFollowUps = !disconnected && !restoredFollowUps;
          if (!disconnected) restoredFollowUps = true;
          dispatchStream({
            type: 'stream_failure',
            sessionId: runSessionId,
            error: message,
            drainedFollowUps,
            restoreFollowUps,
            message: {
              id: nextId(),
              sessionId: runSessionId,
              role: 'assistant',
              content: message,
              createdAt: deps.now(),
              metadata: null,
              error: message,
            },
          });
          console.error(error);
        } finally {
          dispatchStream({ type: 'run_settled', sessionId: runSessionId });
          const outcome = runFailed ? 'failed' : 'completed';
          const hasQueue = Boolean(get().queuedFollowUpsBySessionId[runSessionId]?.length);
          if (shouldAutoRunFollowUps(outcome, hasQueue)) {
            await get().runAgentAnalysis(runSessionId, { includeDraft: false });
          }
        }
      },

      resumeAgentConversation: async (sessionId) => {
        if (get().agentChatActionKey) return;
        if (get().activeAgentSessionId === sessionId) return;
        if (get().agentSessionById[sessionId]) {
          set((s) => {
            const summary = s.agentSessionHistory.find((item) => item.id === sessionId);
            const selection = {
              selectedAgentId: summary?.agentId ?? s.selectedAgentId,
              activeAgentSessionId: sessionId,
            } satisfies AgentSelection;
            return {
              ...sessionProviderModel(s.agentSessionById[sessionId]),
              ...selectionUpdate(s, selection),
            };
          });
          return;
        }
        const actionKey = `resume:${sessionId}`;
        set({ agentChatActionKey: actionKey });
        try {
          const payload = await deps.fetchAgentSession(sessionId);
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
            };
            const selection = {
              selectedAgentId: payload.session?.agentId ?? s.selectedAgentId,
              activeAgentSessionId: sessionId,
            } satisfies AgentSelection;
            return {
              agentSessionById,
              runStateBySessionId,
              ...sessionProviderModel(payload),
              ...selectionUpdate(next, selection),
            };
          });
        } catch (error) {
          console.error(error);
        } finally {
          set((s) => ({ agentChatActionKey: s.agentChatActionKey === actionKey ? null : s.agentChatActionKey }));
        }
      },

      deleteAgentConversation: async (sessionId) => {
        if (get().agentChatActionKey) return;
        if (get().runStateBySessionId[sessionId]?.status === 'running') return;
        const actionKey = `delete:${sessionId}`;
        set({ agentChatActionKey: actionKey });
        try {
          const payload = await deps.deleteAgentSessionById(sessionId);
          deps.setMarketState(payload.state);
          set((s) => {
            const agentSessionById = { ...s.agentSessionById };
            delete agentSessionById[sessionId];
            const runStateBySessionId = { ...mergeHistoryRuns(payload.history.sessions, s.runStateBySessionId) };
            delete runStateBySessionId[sessionId];
            const draftBySessionId = { ...s.draftBySessionId };
            delete draftBySessionId[sessionId];
            const queuedFollowUpsBySessionId = { ...s.queuedFollowUpsBySessionId };
            delete queuedFollowUpsBySessionId[sessionId];
            const streamingMessageBySessionId = { ...s.streamingMessageBySessionId };
            delete streamingMessageBySessionId[sessionId];
            const activeAgentSessionId = s.activeAgentSessionId === sessionId
              ? payload.history.sessions[0]?.id ?? null
              : s.activeAgentSessionId;
            const next = {
              ...s,
              agentSessionById,
              runStateBySessionId,
              draftBySessionId,
              queuedFollowUpsBySessionId,
              streamingMessageBySessionId,
              agentSessionHistory: payload.history.sessions,
              activeAgentSessionId,
            };
            return {
              agentSessionById,
              runStateBySessionId,
              draftBySessionId,
              queuedFollowUpsBySessionId,
              streamingMessageBySessionId,
              agentSessionHistory: payload.history.sessions,
              activeAgentSessionId,
              ...activeFields(next),
            };
          });
        } catch (error) {
          console.error(error);
        } finally {
          set((s) => ({ agentChatActionKey: s.agentChatActionKey === actionKey ? null : s.agentChatActionKey }));
        }
      },
    };
  });
}

export const useAgentStore = createAgentStore();
