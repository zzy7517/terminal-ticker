/** Origin store: identity-free Runtime Session lifecycle and streaming timeline. */
import { create } from 'zustand';
import {
  createOrigin as createOriginRequest,
  deleteOrigin as deleteOriginRequest,
  fetchOrigin,
  fetchOrigins,
  stopOrigin as stopOriginRequest,
  streamOriginMessage,
} from '../api';
import type {
  AgentMessage,
  OriginSessionResponse,
  OriginSessionSummary,
  CreateOriginInput,
} from '../types';

interface OriginState {
  origins: OriginSessionSummary[];
  sessionById: Record<string, OriginSessionResponse>;
  activeOriginId: string | null;
  draftById: Record<string, string>;
  streamingById: Record<string, string>;
  runningIds: Set<string>;
  loading: boolean;
  error: string | null;
  init: () => () => void;
  create: (input?: CreateOriginInput) => Promise<string>;
  select: (sessionId: string) => Promise<void>;
  remove: (sessionId: string) => Promise<void>;
  stop: (sessionId: string) => Promise<void>;
  setDraft: (value: string) => void;
  send: (skillNames?: string[]) => Promise<void>;
}

let optimisticId = 0;

export const useOriginStore = create<OriginState>((set, get) => ({
  origins: [],
  sessionById: {},
  activeOriginId: null,
  draftById: {},
  streamingById: {},
  runningIds: new Set(),
  loading: false,
  error: null,

  init: () => {
    let disposed = false;
    set({ loading: true, error: null });
    void fetchOrigins()
      .then((payload) => { if (!disposed) set({ origins: payload.sessions }); })
      .catch((error) => { if (!disposed) set({ error: errorMessage(error) }); })
      .finally(() => { if (!disposed) set({ loading: false }); });
    return () => { disposed = true; };
  },

  create: async (input = {}) => {
    set({ loading: true, error: null });
    try {
      const payload = await createOriginRequest(input);
      const sessionId = payload.session?.id;
      if (!sessionId) throw new Error('Origin create returned no Session');
      set((state) => ({
        origins: payload.history.sessions,
        sessionById: { ...state.sessionById, [sessionId]: payload },
        activeOriginId: sessionId,
      }));
      return sessionId;
    } catch (error) {
      set({ error: errorMessage(error) });
      throw error;
    } finally {
      set({ loading: false });
    }
  },

  select: async (sessionId) => {
    set({ activeOriginId: sessionId, error: null });
    if (get().sessionById[sessionId]) return;
    set({ loading: true });
    try {
      const payload = await fetchOrigin(sessionId);
      set((state) => ({ sessionById: { ...state.sessionById, [sessionId]: payload } }));
    } catch (error) {
      set({ error: errorMessage(error) });
    } finally {
      set({ loading: false });
    }
  },

  remove: async (sessionId) => {
    if (get().runningIds.has(sessionId)) return;
    set({ loading: true, error: null });
    try {
      const payload = await deleteOriginRequest(sessionId);
      set((state) => {
        const sessionById = { ...state.sessionById };
        const draftById = { ...state.draftById };
        const streamingById = { ...state.streamingById };
        delete sessionById[sessionId];
        delete draftById[sessionId];
        delete streamingById[sessionId];
        return {
          origins: payload.history.sessions,
          sessionById,
          draftById,
          streamingById,
          activeOriginId: state.activeOriginId === sessionId ? null : state.activeOriginId,
        };
      });
    } catch (error) {
      set({ error: errorMessage(error) });
    } finally {
      set({ loading: false });
    }
  },

  stop: async (sessionId) => {
    try {
      await stopOriginRequest(sessionId);
    } catch (error) {
      set({ error: errorMessage(error) });
    }
  },

  setDraft: (value) => set((state) => {
    const sessionId = state.activeOriginId;
    if (!sessionId) return state;
    return { draftById: { ...state.draftById, [sessionId]: value } };
  }),

  send: async (skillNames = []) => {
    const initial = get();
    const sessionId = initial.activeOriginId;
    if (!sessionId || initial.runningIds.has(sessionId)) return;
    const prompt = (initial.draftById[sessionId] ?? '').trim();
    if (!prompt) return;
    const optimistic: AgentMessage = {
      id: `origin-user-${Date.now()}-${++optimisticId}`,
      sessionId,
      role: 'user',
      content: prompt,
      createdAt: new Date().toISOString(),
      metadata: null,
      error: null,
    };
    set((state) => {
      const previous = state.sessionById[sessionId] ?? { session: null, messages: [] };
      const runningIds = new Set(state.runningIds);
      runningIds.add(sessionId);
      return {
        sessionById: {
          ...state.sessionById,
          [sessionId]: { ...previous, messages: [...previous.messages, optimistic] },
        },
        draftById: { ...state.draftById, [sessionId]: '' },
        streamingById: { ...state.streamingById, [sessionId]: '' },
        runningIds,
        error: null,
      };
    });
    try {
      await streamOriginMessage(sessionId, prompt, { skillNames }, (envelope) => {
        const event = envelope.event;
        if (event.type === 'message_update') {
          set((state) => ({
            streamingById: {
              ...state.streamingById,
              [sessionId]: (state.streamingById[sessionId] ?? '') + (event.delta ?? ''),
            },
          }));
        } else if (event.type === 'message_end' && event.message.role !== 'user') {
          const message: AgentMessage = {
            id: event.message.id ?? `origin-message-${Date.now()}-${++optimisticId}`,
            sessionId,
            role: event.message.role ?? 'assistant',
            content: event.message.content ?? '',
            createdAt: event.message.createdAt ?? new Date().toISOString(),
            metadata: event.message.metadata ?? null,
            error: event.message.error ?? null,
          };
          set((state) => {
            const previous = state.sessionById[sessionId] ?? { session: null, messages: [] };
            const streamingById = { ...state.streamingById };
            if (message.role === 'assistant') delete streamingById[sessionId];
            return {
              sessionById: {
                ...state.sessionById,
                [sessionId]: { ...previous, messages: [...previous.messages, message] },
              },
              streamingById,
            };
          });
        } else if (event.type === 'session_update') {
          const session = event.session;
          const history = event.history;
          set((state) => ({
            origins: history.sessions,
            sessionById: { ...state.sessionById, [sessionId]: session },
          }));
        } else if (event.type === 'error') {
          set({ error: event.error });
        }
      });
    } catch (error) {
      set({ error: errorMessage(error) });
    } finally {
      set((state) => {
        const runningIds = new Set(state.runningIds);
        runningIds.delete(sessionId);
        const streamingById = { ...state.streamingById };
        delete streamingById[sessionId];
        return { runningIds, streamingById };
      });
    }
  },
}));

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
