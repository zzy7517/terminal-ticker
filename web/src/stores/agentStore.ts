/** 管理 Agent 选择、Session 历史、流式消息和操作状态的 Zustand store。 */
import { chronologicalMessages } from '../chat/timeline';
import { create } from 'zustand';
import type {
  AgentDefinition,
  AgentDirectMessage,
  AgentMessage,
  AgentModelRegistry,
  AgentSessionResponse,
  AgentSessionSummary,
  QueuedFollowUp,
} from '../types';
import {
  AgentStreamDisconnectError,
  createAgentSession,
  deleteAgentSessionById,
  fetchAgentDirectMessages,
  fetchAgentModelRegistry,
  fetchAgents,
  fetchAgentSession,
  fetchAgentSessions,
  sendAgentDirectMessage,
  setDirectMessageReaction,
  streamAgentMessage,
  type ImageAttachment,
} from '../api';
import { useMarketStore } from './marketStore';
import { mergeFollowUps, shouldAutoRunFollowUps, validateFollowUpImages } from '../utils/followUpQueue';
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
  NEW_SESSION_PENDING_KEY,
  pendingImagesKey,
  replaceRunState,
  selectionUpdate,
  sessionFromSummary,
  upsertOptimisticSessionSummary,
  type AgentSelection,
  type SessionRunProjection,
} from './agent/sessionProjection';

const initialProvider = loadPersistedProvider();
const initialModels = loadPersistedModels();

interface AgentState {
  agents: AgentDefinition[];
  selectedAgentId: string;
  directMessageIdByAgentId: Record<string, string>;
  directMessagesByAgentId: Record<string, AgentDirectMessage[]>;
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
  refreshAgentDirectMessages: (agentId: string) => Promise<void>;
  toggleDirectMessageReaction: (agentId: string, messageId: string, emoji: string) => Promise<void>;
  selectAgent: (agentId: string) => Promise<void>;
  runAgentAnalysis: (sessionId?: string, options?: { includeDraft?: boolean }) => Promise<void>;
  removeFollowUp: (id: string) => void;
  clearFollowUps: () => void;
  resumeAgentConversation: (sessionId: string) => Promise<void>;
  deleteAgentConversation: (sessionId: string) => Promise<void>;
}

let modelRegistryRequest: Promise<AgentModelRegistry> | null = null;

export const useAgentStore = create<AgentState>((set, get) => ({
  agents: [],
  selectedAgentId: 'default',
  directMessageIdByAgentId: {},
  directMessagesByAgentId: {},
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

  refreshAgentDirectMessages: async (agentId) => {
    const payload = await fetchAgentDirectMessages(agentId);
    // API returns newest-first (dm_seq DESC) for before_seq pagination; UI is oldest→newest.
    const messages = chronologicalMessages(payload.messages).map((message) => ({
      ...message,
      reactions: message.reactions ?? [],
    }));
    set((s) => ({
      directMessageIdByAgentId: { ...s.directMessageIdByAgentId, [agentId]: payload.target.directMessageId },
      directMessagesByAgentId: { ...s.directMessagesByAgentId, [agentId]: messages },
    }));
  },

  toggleDirectMessageReaction: async (agentId, messageId, emoji) => {
    const current = get().directMessagesByAgentId[agentId] ?? [];
    const message = current.find((entry) => entry.id === messageId);
    if (!message) return;
    const active = !message.reactions.some((reaction) => reaction.emoji === emoji && reaction.reacted);
    try {
      const payload = await setDirectMessageReaction(agentId, messageId, emoji, active);
      set((s) => ({
        directMessagesByAgentId: {
          ...s.directMessagesByAgentId,
          [agentId]: (s.directMessagesByAgentId[agentId] ?? []).map((entry) => (
            entry.id === messageId ? { ...entry, ...payload.message, reactions: payload.message.reactions ?? [] } : entry
          )),
        },
      }));
    } catch (error) {
      console.error('Direct Message reaction failed:', error);
    }
  },

  selectAgent: async (agentId) => {
    if (get().agentChatActionKey) return;
    try {
      const [payload, agentPayload] = await Promise.all([
        fetchAgentDirectMessages(agentId),
        fetchAgents().catch((error) => {
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

  initSessions: () => {
    let disposed = false;
    const key = 'global';
    set({ agentSessionHistoryLoadingKey: key });
    fetchAgentSessions()
      .then(async (payload) => {
        if (disposed) return;
        const agentPayload = await fetchAgents();
        const firstSummary = payload.sessions[0] ?? null;
        const selectedAgentId = firstSummary?.agentId ?? agentPayload.agents[0]?.id ?? 'default';
        const directMessages = await fetchAgentDirectMessages(selectedAgentId).catch((error) => {
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
        void import('../chat/directMessageWorkspace').then(({ bindSelectedDirectMessage }) => {
          if (!disposed) bindSelectedDirectMessage();
        });
        const activeSessionId = get().activeAgentSessionId ?? firstSummary?.id ?? null;
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
        await sendAgentDirectMessage(state.selectedAgentId, content, images.length ? images : undefined);
        set((s) => {
          const pendingImagesBySessionId = { ...s.pendingImagesBySessionId };
          delete pendingImagesBySessionId[draftKey];
          const draftBySessionId = { ...s.draftBySessionId, [draftKey]: '' };
          const next = { ...s, pendingImagesBySessionId, draftBySessionId };
          return { pendingImagesBySessionId, draftBySessionId, ...activeFields(next) };
        });
        await get().refreshAgentDirectMessages(state.selectedAgentId);
        const { markDirectMessageReadIfActive } = await import('../chat/directMessageWorkspace');
        markDirectMessageReadIfActive(state.selectedAgentId);
      } catch (error) {
        console.error('Agent Direct Message send failed:', error);
      }
      return;
    }

    const agentPrompt = includeDraft
      ? state.draftBySessionId[requestedSessionId] ?? ''
      : '';
    let targetSessionId: string | null = requestedSessionId;
    let drainedFollowUps: QueuedFollowUp[] = [];
    let restoredFollowUps = false;
    let runFailed = false;
    const initialBucketKey = pendingImagesKey(targetSessionId);
    const initialImages = get().pendingImagesBySessionId[initialBucketKey] ?? [];
    let idCounter = 0;
    const nextId = () => { idCounter += 1; return -(Date.now() * 100 + idCounter); };

    if (targetSessionId && get().runStateBySessionId[targetSessionId]?.status === 'running') {
      const sessionId = targetSessionId;
      const images = [...(get().pendingImagesBySessionId[initialBucketKey] ?? [])];
      const content = agentPrompt.trim();
      if (!content && images.length === 0) return;
      const queued: QueuedFollowUp = {
        id: `follow-up-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        content,
        images,
        createdAt: new Date().toISOString(),
      };
      set((s) => {
        const queuedFollowUpsBySessionId = {
          ...s.queuedFollowUpsBySessionId,
          [sessionId]: [...(s.queuedFollowUpsBySessionId[sessionId] ?? []), queued],
        };
        const draftBySessionId = { ...s.draftBySessionId, [sessionId]: '' };
        const pendingImagesBySessionId = { ...s.pendingImagesBySessionId };
        delete pendingImagesBySessionId[initialBucketKey];
        const next = { ...s, queuedFollowUpsBySessionId, draftBySessionId, pendingImagesBySessionId };
        return { queuedFollowUpsBySessionId, draftBySessionId, pendingImagesBySessionId, ...activeFields(next) };
      });
      return;
    }

    try {
      if (!targetSessionId) {
        const created = await createAgentSession({
          agentId: state.selectedAgentId,
        });
        targetSessionId = created.session?.id ?? null;
        if (!targetSessionId) throw new Error('agent session create failed');
        const createdSessionId = targetSessionId;
        set((s) => {
          const agentSessionById = cacheSession(s.agentSessionById, created);
          const runStateBySessionId = mergeHistoryRuns(created.history.sessions, {
            ...s.runStateBySessionId,
            [createdSessionId]: mergeRunPayload(s.runStateBySessionId[createdSessionId], createdSessionId, created.run),
          });
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
      const bucketImages = includeDraft
        ? get().pendingImagesBySessionId[bucketKey] ?? get().pendingImagesBySessionId[initialBucketKey] ?? []
        : [];
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
          delete pendingImagesBySessionId[initialBucketKey];
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
        { images: imagesToSend },
        (envelope) => {
          const sessionId = envelope.sessionId || runSessionId;
          const event = envelope.event;
          if (!event) return;

          if (event.type === 'message_start') {
            const raw = event.message;
            if (raw.role === 'assistant') {
              streamingContent = '';
              set((s) => {
                const streamingMessageBySessionId = {
                  ...s.streamingMessageBySessionId,
                  [sessionId]: {
                    id: nextId(),
                    sessionId,
                    role: 'assistant' as const,
                    content: '',
                    createdAt: raw.createdAt ?? new Date().toISOString(),
                    metadata: null,
                    error: null,
                  },
                };
                const next = { ...s, streamingMessageBySessionId };
                return { streamingMessageBySessionId, ...activeFields(next) };
              });
            }
            return;
          }

          if (event.type === 'message_update') {
            const delta = event.delta ?? '';
            if (delta) {
              streamingContent += delta;
              set((s) => {
                const current = s.streamingMessageBySessionId[sessionId];
                if (!current) return {};
                const streamingMessageBySessionId = {
                  ...s.streamingMessageBySessionId,
                  [sessionId]: { ...current, content: streamingContent },
                };
                const next = { ...s, streamingMessageBySessionId };
                return { streamingMessageBySessionId, ...activeFields(next) };
              });
            }
            return;
          }

          if (event.type === 'message_end') {
            const raw = event.message;
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
              const streamingMessageBySessionId = { ...s.streamingMessageBySessionId };
              if (clearStreaming) delete streamingMessageBySessionId[sessionId];
              const next = { ...s, agentSessionById, runStateBySessionId, streamingMessageBySessionId };
              return {
                agentSessionById,
                runStateBySessionId,
                streamingMessageBySessionId,
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
            set((s) => {
              const previous = s.runStateBySessionId[sessionId] ?? idleRun(sessionId);
              const unexpectedError = event.error || null;
              if (unexpectedError) runFailed = true;
              const runStateBySessionId = replaceRunState(
                s.runStateBySessionId,
                sessionId,
                {
                  ...previous,
                  runId: envelope.runId,
                  lastSeq: envelope.seq,
                  status: unexpectedError ? 'error' : previous.status,
                  error: unexpectedError ?? previous.error,
                },
              );
              const streamingMessageBySessionId = { ...s.streamingMessageBySessionId };
              delete streamingMessageBySessionId[sessionId];
              const queuedFollowUpsBySessionId = unexpectedError && !restoredFollowUps
                ? {
                    ...s.queuedFollowUpsBySessionId,
                    [sessionId]: [...drainedFollowUps, ...(s.queuedFollowUpsBySessionId[sessionId] ?? [])],
                  }
                : s.queuedFollowUpsBySessionId;
              if (unexpectedError) restoredFollowUps = true;
              const next = { ...s, runStateBySessionId, queuedFollowUpsBySessionId, streamingMessageBySessionId };
              return { runStateBySessionId, queuedFollowUpsBySessionId, streamingMessageBySessionId, ...activeFields(next) };
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
            runFailed = true;
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
              const queuedFollowUpsBySessionId = restoredFollowUps
                ? s.queuedFollowUpsBySessionId
                : {
                    ...s.queuedFollowUpsBySessionId,
                    [sessionId]: [...drainedFollowUps, ...(s.queuedFollowUpsBySessionId[sessionId] ?? [])],
                  };
              restoredFollowUps = true;
              const streamingMessageBySessionId = { ...s.streamingMessageBySessionId };
              delete streamingMessageBySessionId[sessionId];
              const next = { ...s, agentSessionById, runStateBySessionId, queuedFollowUpsBySessionId, streamingMessageBySessionId };
              return { agentSessionById, runStateBySessionId, queuedFollowUpsBySessionId, streamingMessageBySessionId, ...activeFields(next) };
            });
          }
        },
      );
    } catch (error) {
      runFailed = true;
      const disconnected = error instanceof AgentStreamDisconnectError;
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
          const queuedFollowUpsBySessionId = disconnected || restoredFollowUps
            ? s.queuedFollowUpsBySessionId
            : {
                ...s.queuedFollowUpsBySessionId,
                [errorSessionId]: [...drainedFollowUps, ...(s.queuedFollowUpsBySessionId[errorSessionId] ?? [])],
              };
          if (!disconnected) restoredFollowUps = true;
          const streamingMessageBySessionId = { ...s.streamingMessageBySessionId };
          delete streamingMessageBySessionId[errorSessionId];
          const next = { ...s, agentSessionById, runStateBySessionId, queuedFollowUpsBySessionId, streamingMessageBySessionId };
          return { agentSessionById, runStateBySessionId, queuedFollowUpsBySessionId, streamingMessageBySessionId, ...activeFields(next) };
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
          const streamingMessageBySessionId = { ...s.streamingMessageBySessionId };
          delete streamingMessageBySessionId[finishedSessionId];
          const next = { ...s, runStateBySessionId, streamingMessageBySessionId };
          return { runStateBySessionId, streamingMessageBySessionId, ...activeFields(next) };
        });
        const stateAfterRun = get();
        const outcome = runFailed ? 'failed' : 'completed';
        if (shouldAutoRunFollowUps(outcome, Boolean(stateAfterRun.queuedFollowUpsBySessionId[finishedSessionId]?.length))) {
          await get().runAgentAnalysis(finishedSessionId, { includeDraft: false });
        }
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
      const payload = await deleteAgentSessionById(sessionId);
      useMarketStore.getState().setState(payload.state);
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
}));
