import { create } from 'zustand';
import {
  connectChatEvents,
  createChannel,
  deleteChannelMessage,
  editChannelMessage,
  fetchChannelMessages,
  fetchChannelThread,
  fetchChatBootstrap,
  sendChannelMessage,
  sendChannelThreadReply,
  setChatReference,
  setChannelReaction,
} from '../api';
import type { Channel, ChannelMessage, ChannelThreadResponse, ChatMessageReference, ChatTarget } from '../types';
import { useAgentStore } from './agentStore';

interface ChatState {
  channels: Channel[];
  activeTarget: ChatTarget | null;
  activeCollection: 'saved' | 'pinned' | null;
  messagesByChannelId: Record<string, ChannelMessage[]>;
  nextBeforeSeqByChannelId: Record<string, number | null>;
  threadsByRootId: Record<string, ChannelThreadResponse>;
  saved: ChatMessageReference[];
  pinned: ChatMessageReference[];
  openThreadId: string | null;
  lastEventSeq: number;
  eventStatus: 'connected' | 'disconnected' | 'error';
  loading: boolean;
  sending: boolean;
  error: string | null;
  initChat: () => () => void;
  selectDirectChat: (agentId: string, chatId: string) => void;
  openCollection: (collection: 'saved' | 'pinned') => void;
  selectChannel: (channelId: string) => Promise<void>;
  loadOlderMessages: () => Promise<void>;
  createChannel: (name: string) => Promise<void>;
  sendMessage: (content: string, threadRootId?: string) => Promise<void>;
  openThread: (rootMessageId: string) => Promise<void>;
  closeThread: () => void;
  editMessage: (messageId: string, content: string) => Promise<void>;
  deleteMessage: (messageId: string) => Promise<void>;
  toggleReaction: (message: ChannelMessage, emoji: string) => Promise<void>;
  toggleSaved: (target: ChatTarget, messageId: string) => Promise<void>;
  togglePinned: (target: ChatTarget, messageId: string) => Promise<void>;
}

export const useChatStore = create<ChatState>((set, get) => ({
  channels: [],
  activeTarget: null,
  activeCollection: null,
  messagesByChannelId: {},
  nextBeforeSeqByChannelId: {},
  threadsByRootId: {},
  saved: [],
  pinned: [],
  openThreadId: null,
  lastEventSeq: 0,
  eventStatus: 'disconnected',
  loading: false,
  sending: false,
  error: null,

  initChat: () => {
    let disposed = false;
    let disconnect: (() => void) | null = null;
    let pendingEventSeq = 0;
    let recoveryRunning = false;
    const pendingDirectAgents = new Map<string, number>();
    set({ loading: true, error: null });
    void fetchChatBootstrap()
      .then((payload) => {
        if (disposed) return;
        set({
          channels: payload.channels,
          saved: payload.saved,
          pinned: payload.pinned,
          lastEventSeq: payload.lastEventSeq,
          loading: false,
        });
        disconnect = connectChatEvents(
          payload.lastEventSeq,
          (event) => {
            if (disposed || event.seq <= get().lastEventSeq) return;
            pendingEventSeq = Math.max(pendingEventSeq, event.seq);
            if (event.target.kind === 'direct-chat') {
              pendingDirectAgents.set(
                event.target.agentId,
                Math.max(pendingDirectAgents.get(event.target.agentId) ?? 0, event.seq),
              );
            }
            const recover = async (): Promise<void> => {
              if (recoveryRunning) return;
              recoveryRunning = true;
              let attempt = 0;
              while (!disposed && (pendingEventSeq > get().lastEventSeq || pendingDirectAgents.size > 0)) {
                const targetSeq = pendingEventSeq;
                const directAgents = new Map(pendingDirectAgents);
                const current = get();
                const activeChannelId = current.activeTarget?.kind === 'channel'
                  ? current.activeTarget.channelId
                  : null;
                try {
                  // Bootstrap captures the cursor before reading its projections.
                  // Load dependent projections only afterwards so a newer cursor
                  // can never be committed with an older message snapshot.
                  const snapshot = await fetchChatBootstrap();
                  const [channelMessages, thread] = await Promise.all([
                    activeChannelId ? fetchChannelMessages(activeChannelId) : Promise.resolve(null),
                    current.openThreadId
                      ? fetchChannelThread(current.openThreadId).catch(() => null)
                      : Promise.resolve(null),
                    ...[...directAgents.keys()].map((agentId) => useAgentStore.getState().refreshAgentChats(agentId)),
                  ]);
                  if (disposed) break;
                  set((state) => ({
                    channels: snapshot.channels,
                    saved: snapshot.saved,
                    pinned: snapshot.pinned,
                    lastEventSeq: snapshot.lastEventSeq,
                    error: null,
                    messagesByChannelId: activeChannelId && channelMessages
                      ? { ...state.messagesByChannelId, [activeChannelId]: [...channelMessages.messages].reverse() }
                      : state.messagesByChannelId,
                    nextBeforeSeqByChannelId: activeChannelId && channelMessages
                      ? { ...state.nextBeforeSeqByChannelId, [activeChannelId]: channelMessages.nextBeforeSeq }
                      : state.nextBeforeSeqByChannelId,
                    threadsByRootId: thread
                      ? { ...state.threadsByRootId, [thread.root.id]: thread }
                      : state.threadsByRootId,
                  }));
                  for (const [agentId, seq] of directAgents) {
                    if ((pendingDirectAgents.get(agentId) ?? 0) <= seq) pendingDirectAgents.delete(agentId);
                  }
                  if (snapshot.lastEventSeq < targetSeq) {
                    await delay(100);
                  }
                  attempt = 0;
                } catch (error) {
                  if (disposed) break;
                  set({ error: error instanceof Error ? error.message : String(error) });
                  attempt += 1;
                  await delay(Math.min(5000, 500 * attempt));
                }
              }
              recoveryRunning = false;
            };
            void recover();
          },
          (eventStatus) => { if (!disposed) set({ eventStatus }); },
        );
      })
      .catch((error) => {
        if (!disposed) set({ loading: false, error: error instanceof Error ? error.message : String(error) });
      });
    return () => {
      disposed = true;
      disconnect?.();
    };
  },

  selectDirectChat: (agentId, chatId) => set({
    activeTarget: { kind: 'direct-chat', agentId, chatId },
    activeCollection: null,
    openThreadId: null,
  }),

  openCollection: (activeCollection) => set({ activeCollection, openThreadId: null }),

  selectChannel: async (channelId) => {
    set({ activeTarget: { kind: 'channel', channelId }, activeCollection: null, openThreadId: null, loading: true, error: null });
    try {
      const payload = await fetchChannelMessages(channelId);
      set((state) => ({
        messagesByChannelId: {
          ...state.messagesByChannelId,
          [channelId]: [...payload.messages].reverse(),
        },
        nextBeforeSeqByChannelId: {
          ...state.nextBeforeSeqByChannelId,
          [channelId]: payload.nextBeforeSeq,
        },
      }));
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error) });
    } finally {
      set({ loading: false });
    }
  },

  loadOlderMessages: async () => {
    const target = get().activeTarget;
    if (target?.kind !== 'channel' || get().loading) return;
    const beforeSeq = get().nextBeforeSeqByChannelId[target.channelId];
    if (!beforeSeq) return;
    set({ loading: true, error: null });
    try {
      const payload = await fetchChannelMessages(target.channelId, beforeSeq);
      set((state) => ({
        messagesByChannelId: {
          ...state.messagesByChannelId,
          [target.channelId]: [
            ...[...payload.messages].reverse(),
            ...(state.messagesByChannelId[target.channelId] ?? []),
          ],
        },
        nextBeforeSeqByChannelId: {
          ...state.nextBeforeSeqByChannelId,
          [target.channelId]: payload.nextBeforeSeq,
        },
      }));
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error) });
    } finally {
      set({ loading: false });
    }
  },

  createChannel: async (name) => {
    const clean = name.trim();
    if (!clean) return;
    set({ loading: true, error: null });
    try {
      const payload = await createChannel({ name: clean });
      set({ channels: payload.channels });
      await get().selectChannel(payload.channel.id);
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error) });
    } finally {
      set({ loading: false });
    }
  },

  sendMessage: async (content, threadRootId) => {
    const target = get().activeTarget;
    const clean = content.trim();
    if (target?.kind !== 'channel' || !clean || get().sending) return;
    set({ sending: true, error: null });
    try {
      if (threadRootId) {
        const payload = await sendChannelThreadReply(threadRootId, clean);
        set((state) => ({
          threadsByRootId: { ...state.threadsByRootId, [threadRootId]: payload.thread },
          messagesByChannelId: replaceMessage(
            state.messagesByChannelId,
            target.channelId,
            payload.thread.root,
          ),
        }));
      } else {
        const payload = await sendChannelMessage(target.channelId, clean);
        set((state) => ({
          channels: replaceChannel(state.channels, payload.channel),
          messagesByChannelId: {
            ...state.messagesByChannelId,
            [target.channelId]: [...(state.messagesByChannelId[target.channelId] ?? []), payload.message],
          },
        }));
      }
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error) });
    } finally {
      set({ sending: false });
    }
  },

  openThread: async (rootMessageId) => {
    set({ openThreadId: rootMessageId, loading: true, error: null });
    try {
      const thread = await fetchChannelThread(rootMessageId);
      set((state) => ({ threadsByRootId: { ...state.threadsByRootId, [rootMessageId]: thread } }));
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error) });
    } finally {
      set({ loading: false });
    }
  },

  closeThread: () => set({ openThreadId: null }),

  editMessage: async (messageId, content) => {
    const clean = content.trim();
    if (!clean) return;
    try {
      const payload = await editChannelMessage(messageId, clean);
      set((state) => updateMessageState(state, payload.message, payload.channel));
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error) });
    }
  },

  deleteMessage: async (messageId) => {
    try {
      const payload = await deleteChannelMessage(messageId);
      set((state) => updateMessageState(state, payload.message, payload.channel));
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error) });
    }
  },

  toggleReaction: async (message, emoji) => {
    const active = !message.reactions.some((reaction) => reaction.emoji === emoji && reaction.reacted);
    try {
      const payload = await setChannelReaction(message.id, emoji, active);
      set((state) => updateMessageState(state, payload.message, payload.channel));
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error) });
    }
  },

  toggleSaved: async (target, messageId) => {
    const active = !get().saved.some((reference) => sameReference(reference, target, messageId));
    try {
      const payload = await setChatReference('saved', target, messageId, active);
      set({ saved: payload.saved, pinned: payload.pinned });
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error) });
    }
  },

  togglePinned: async (target, messageId) => {
    const active = !get().pinned.some((reference) => sameReference(reference, target, messageId));
    try {
      const payload = await setChatReference('pins', target, messageId, active);
      set({ saved: payload.saved, pinned: payload.pinned });
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error) });
    }
  },
}));

function replaceChannel(channels: Channel[], next: Channel): Channel[] {
  return channels.map((channel) => channel.id === next.id ? next : channel);
}

function replaceMessage(
  messagesByChannelId: Record<string, ChannelMessage[]>,
  channelId: string,
  next: ChannelMessage,
): Record<string, ChannelMessage[]> {
  return {
    ...messagesByChannelId,
    [channelId]: (messagesByChannelId[channelId] ?? []).map((message) => message.id === next.id ? next : message),
  };
}

function updateMessageState(state: ChatState, message: ChannelMessage, channel: Channel): Partial<ChatState> {
  const threadsByRootId = { ...state.threadsByRootId };
  for (const [rootId, thread] of Object.entries(threadsByRootId)) {
    if (thread.root.id === message.id) {
      threadsByRootId[rootId] = { ...thread, root: message };
    } else if (thread.replies.some((reply) => reply.id === message.id)) {
      threadsByRootId[rootId] = {
        ...thread,
        replies: thread.replies.map((reply) => reply.id === message.id ? message : reply),
      };
    }
  }
  return {
    channels: replaceChannel(state.channels, channel),
    messagesByChannelId: replaceMessage(state.messagesByChannelId, message.channelId, message),
    threadsByRootId,
  };
}

function sameReference(reference: ChatMessageReference, target: ChatTarget, messageId: string): boolean {
  if (reference.messageId !== messageId || reference.target.kind !== target.kind) return false;
  return target.kind === 'channel'
    ? reference.target.kind === 'channel' && reference.target.channelId === target.channelId
    : reference.target.kind === 'direct-chat'
      && reference.target.agentId === target.agentId
      && reference.target.chatId === target.chatId;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}
