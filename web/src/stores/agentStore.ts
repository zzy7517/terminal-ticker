import { create } from 'zustand';
import type { AgentMessage, AgentModelOption, AgentSessionResponse, AgentSessionSummary } from '../types';
import {
  createAgentSession,
  deleteAgentSessionById,
  fetchAgentSession,
  fetchAgentSessionHistory,
  fetchAgentSessions,
  fetchProviderModels,
  streamAgentMessage,
} from '../api';
import { AGENT_PROVIDER_OPTIONS } from '../constants';
import { streamMessageToAgentMessage, upsertAgentMessage } from '../utils';
import { useMarketStore } from './marketStore';

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
  agentCandidateKeys: string[];
  pendingToolCalls: Set<string>;
  modelCache: Record<string, AgentModelOption[]>;
  contextUsage: { promptTokens: number; totalTokens: number } | null;

  setAgentSession: (session: AgentSessionResponse | null) => void;
  setAgentSessionHistory: (history: AgentSessionSummary[]) => void;
  setAgentPrompt: (prompt: string) => void;
  setAgentProvider: (provider: string) => void;
  setAgentModel: (model: string) => void;
  toggleAgentCandidate: (key: string) => void;
  clearAgentCandidates: () => void;
  filterCandidateKeys: (validKeys: string[]) => void;
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

const streamMessageIdsRef = new Map<string, number>();

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
  agentCandidateKeys: [],
  pendingToolCalls: new Set(),
  modelCache: {},
  contextUsage: null,

  setAgentSession: (session) => set({ agentSession: session }),
  setAgentSessionHistory: (history) => set({ agentSessionHistory: history }),
  setAgentPrompt: (prompt) => set({ agentPrompt: prompt }),
  setAgentProvider: (provider) => set({ agentProvider: provider }),
  setAgentModel: (model) => set({ agentModel: model }),
  toggleAgentCandidate: (key) => set((s) => ({
    agentCandidateKeys: s.agentCandidateKeys.includes(key)
      ? s.agentCandidateKeys.filter((k) => k !== key)
      : [...s.agentCandidateKeys, key],
  })),
  clearAgentCandidates: () => set({ agentCandidateKeys: [] }),
  filterCandidateKeys: (validKeys) => set((s) => ({
    agentCandidateKeys: s.agentCandidateKeys.filter((k) => validKeys.includes(k)),
  })),
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
        set({ agentSessionHistory: payload.sessions });
        if (!get().agentSession?.session && payload.sessions[0]) {
          set({ agentSessionLoadingKey: key });
          fetchAgentSession(payload.sessions[0].id)
            .then((sessionPayload) => { if (!disposed) set({ agentSession: sessionPayload }); })
            .catch((error) => { console.error(error); if (!disposed) set({ agentSession: null }); })
            .finally(() => { if (!disposed) set({ agentSessionLoadingKey: null }); });
        }
      })
      .catch((error) => { console.error(error); if (!disposed) set({ agentSessionHistory: [] }); })
      .finally(() => { if (!disposed) set({ agentSessionHistoryLoadingKey: null }); });
    return () => { disposed = true; };
  },

  runAgentAnalysis: async () => {
    const { agentSession, agentPrompt, agentProvider, agentModel, agentCandidateKeys } = get();
    let targetSessionId = agentSession?.session?.id ?? null;
    set({ agentBusyKey: targetSessionId ?? 'new', pendingToolCalls: new Set() });
    streamMessageIdsRef.clear();
    try {
      if (!targetSessionId) {
        const created = await createAgentSession({ provider: agentProvider, model: agentModel });
        targetSessionId = created.session?.id ?? null;
        set({ agentSession: created, agentSessionHistory: created.history.sessions });
      }
      if (!targetSessionId) throw new Error('agent session create failed');
      set({ agentBusyKey: targetSessionId });
      await streamAgentMessage(
        targetSessionId,
        agentPrompt,
        { provider: agentProvider, model: agentModel, candidateInstrumentKeys: agentCandidateKeys },
        (event) => {
          if (event.type === 'tool_execution_start') {
            set((s) => { const next = new Set(s.pendingToolCalls); next.add(event.toolCall.id); return { pendingToolCalls: next }; });
            return;
          }
          if (event.type === 'tool_execution_end') {
            set((s) => { const next = new Set(s.pendingToolCalls); next.delete(event.toolCall.id); return { pendingToolCalls: next }; });
            return;
          }
          if (event.type === 'message_start' || event.type === 'message_update' || event.type === 'message_end') {
            const raw = event.message;
            const clientId = raw.clientId;
            let fallbackId = typeof raw.id === 'number' ? raw.id : 0;
            if (!fallbackId) {
              if (clientId && streamMessageIdsRef.has(clientId)) {
                fallbackId = streamMessageIdsRef.get(clientId) ?? 0;
              } else {
                fallbackId = -Date.now() - streamMessageIdsRef.size;
                if (clientId) streamMessageIdsRef.set(clientId, fallbackId);
              }
            }
            const createdAt = new Date().toISOString();
            set((s) => {
              const session = s.agentSession ?? { session: null, messages: [] };
              const message = streamMessageToAgentMessage(raw, {
                id: fallbackId,
                sessionId: session.session?.id ?? targetSessionId ?? '',
                createdAt,
              });
              return { agentSession: { ...session, messages: upsertAgentMessage(session.messages, message) } };
            });
            return;
          }
          if (event.type === 'agent_end') {
            if (typeof event.totalTokens === 'number') {
              set({ contextUsage: { promptTokens: event.promptTokens ?? 0, totalTokens: event.totalTokens } });
            }
            return;
          }
          if (event.type === 'session_update') {
            useMarketStore.getState().setState(event.state);
            set({
              agentSession: event.session,
              agentSessionHistory: event.history.sessions,
              pendingToolCalls: new Set(),
            });
            streamMessageIdsRef.clear();
            return;
          }
          if (event.type === 'error') {
            const createdAt = new Date().toISOString();
            set((s) => {
              const session = s.agentSession ?? { session: null, messages: [] };
              const message: AgentMessage = {
                id: -Date.now(),
                sessionId: session.session?.id ?? targetSessionId ?? '',
                role: 'assistant',
                content: event.error,
                createdAt,
                metadata: null,
                error: event.error,
              };
              return { agentSession: { ...session, messages: upsertAgentMessage(session.messages, message) } };
            });
          }
        },
      );
      set({ agentPrompt: '' });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'agent analysis failed';
      set((s) => {
        const session = s.agentSession ?? { session: null, messages: [] };
        return {
          agentSession: {
            ...session,
            messages: upsertAgentMessage(session.messages, {
              id: -Date.now(),
              sessionId: session.session?.id ?? targetSessionId ?? '',
              role: 'assistant',
              content: message,
              createdAt: new Date().toISOString(),
              metadata: null,
              error: message,
            }),
          },
        };
      });
    } finally {
      set({ pendingToolCalls: new Set(), agentBusyKey: null });
    }
  },

  resetAgentConversation: async () => {
    const { agentProvider, agentModel } = get();
    set({ agentBusyKey: 'new', contextUsage: null });
    try {
      const payload = await createAgentSession({ provider: agentProvider, model: agentModel });
      set({ agentSession: payload, agentSessionHistory: payload.history.sessions, agentPrompt: '' });
    } catch (error) {
      console.error(error);
    } finally {
      set({ agentBusyKey: null });
    }
  },

  resumeAgentConversation: async (sessionId) => {
    if (get().agentSessionActionKey) return;
    const actionKey = `resume:${sessionId}`;
    set({ agentSessionActionKey: actionKey });
    try {
      const payload = await fetchAgentSession(sessionId);
      const history = await fetchAgentSessionHistory();
      set({ agentSession: payload, agentSessionHistory: history.sessions, agentPrompt: '' });
    } catch (error) {
      console.error(error);
    } finally {
      set((s) => ({ agentSessionActionKey: s.agentSessionActionKey === actionKey ? null : s.agentSessionActionKey }));
    }
  },

  deleteAgentConversation: async (sessionId) => {
    if (get().agentSessionActionKey) return;
    const confirmed = window.confirm('Delete this saved agent session?');
    if (!confirmed) return;
    const actionKey = `delete:${sessionId}`;
    set({ agentSessionActionKey: actionKey });
    try {
      const payload = await deleteAgentSessionById(sessionId);
      useMarketStore.getState().setState(payload.state);
      set((s) => ({
        agentSession: s.agentSession?.session?.id === sessionId ? { session: null, messages: [] } : s.agentSession,
        agentSessionHistory: payload.history.sessions,
        agentPrompt: '',
      }));
    } catch (error) {
      console.error(error);
    } finally {
      set((s) => ({ agentSessionActionKey: s.agentSessionActionKey === actionKey ? null : s.agentSessionActionKey }));
    }
  },
}));
