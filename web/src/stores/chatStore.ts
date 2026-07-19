/**
 * chatStore — 前端 Chat 壳状态（对应 Raft Chat：Channels + Saved/Pinned + 未读）。
 *
 * 管理 Channel 列表/消息/thread、活动目标、引用与未读游标；
 * Agent DM timeline 仍由 agentStore 持有，本 Store 只协调 Chat 壳导航。
 */
import { create } from 'zustand';
import {
  connectChatEvents,
  createChannel,
  deleteChannelMessage,
  editChannelMessage,
  fetchChannelMessages,
  fetchChannelThread,
  fetchChatBootstrap,
  markChatUnreadRead,
  sendChannelMessage,
  sendChannelThreadReply,
  setChatReference,
  setChannelReaction,
} from '../api';
import type { Channel, ChannelMessage, ChannelThreadResponse, ChatMessageReference, ChatTarget, ChatUnreadEntry } from '../types';
import { agentIdForDirectMessage, recoverDirectMessageTarget } from '../chat/directMessageWorkspace';
import { chronologicalMessages } from '../chat/timeline';
import { useAgentStore } from './agentStore';

/** Chat 壳 Zustand 状态：Channel / 引用 / 未读 / 活动目标。 */
interface ChatState {
  channels: Channel[];
  activeTarget: ChatTarget | null;
  activeCollection: 'saved' | 'pinned' | null;
  messagesByChannelId: Record<string, ChannelMessage[]>;
  nextBeforeSeqByChannelId: Record<string, number | null>;
  threadsByRootId: Record<string, ChannelThreadResponse>;
  saved: ChatMessageReference[];
  pinned: ChatMessageReference[];
  unread: ChatUnreadEntry[];
  openThreadId: string | null;
  agentProfileOpen: boolean;
  lastEventSeq: number;
  eventStatus: 'connected' | 'disconnected' | 'error';
  loading: boolean;
  sending: boolean;
  error: string | null;
  initChat: () => () => void;
  selectDirectMessage: (directMessageId: string) => void;
  openCollection: (collection: 'saved' | 'pinned') => void;
  selectChannel: (channelId: string) => Promise<void>;
  loadOlderMessages: () => Promise<void>;
  createChannel: (name: string) => Promise<void>;
  sendMessage: (content: string, threadRootId?: string) => Promise<void>;
  openThread: (rootMessageId: string) => Promise<void>;
  closeThread: () => void;
  toggleAgentProfile: () => void;
  closeAgentProfile: () => void;
  editMessage: (messageId: string, content: string) => Promise<void>;
  deleteMessage: (messageId: string) => Promise<void>;
  toggleReaction: (message: ChannelMessage, emoji: string) => Promise<void>;
  toggleSaved: (target: ChatTarget, messageId: string) => Promise<void>;
  togglePinned: (target: ChatTarget, messageId: string) => Promise<void>;
  markTargetRead: (target: ChatTarget, seq: number, messageId?: string | null) => Promise<void>;
}

/** Human Chat 壳 Store：bootstrap、选中目标、发消息、Saved/Pinned、未读。 */
export const useChatStore = create<ChatState>((set, get) => ({
  channels: [],
  activeTarget: null,
  activeCollection: null,
  messagesByChannelId: {},
  nextBeforeSeqByChannelId: {},
  threadsByRootId: {},
  saved: [],
  pinned: [],
  unread: [],
  openThreadId: null,
  agentProfileOpen: false,
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
    const pendingDirectTargets = new Map<string, number>();
    set({ loading: true, error: null });
    void fetchChatBootstrap()
      .then((payload) => {
        if (disposed) return;
        set({
          channels: payload.channels,
          saved: payload.saved,
          pinned: payload.pinned,
          unread: payload.unread ?? [],
          lastEventSeq: payload.lastEventSeq,
          loading: false,
        });
        disconnect = connectChatEvents(
          payload.lastEventSeq,
          (event) => {
            if (disposed || event.seq <= get().lastEventSeq) return;
            pendingEventSeq = Math.max(pendingEventSeq, event.seq);
            if (event.target.kind === 'direct-message') {
              const directMessageId = event.target.directMessageId;
              pendingDirectTargets.set(
                directMessageId,
                Math.max(pendingDirectTargets.get(directMessageId) ?? 0, event.seq),
              );
            }
            const recover = async (): Promise<void> => {
              if (recoveryRunning) return;
              recoveryRunning = true;
              let attempt = 0;
              while (!disposed && (pendingEventSeq > get().lastEventSeq || pendingDirectTargets.size > 0)) {
                const targetSeq = pendingEventSeq;
                const directTargets = new Map(pendingDirectTargets);
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
                    ...[...directTargets.keys()].map((directMessageId) => recoverDirectMessageTarget(directMessageId)),
                  ]);
                  if (disposed) break;
                  set((state) => ({
                    channels: snapshot.channels,
                    saved: snapshot.saved,
                    pinned: snapshot.pinned,
                    unread: snapshot.unread ?? state.unread,
                    lastEventSeq: snapshot.lastEventSeq,
                    error: null,
                    messagesByChannelId: activeChannelId && channelMessages
                      ? { ...state.messagesByChannelId, [activeChannelId]: chronologicalMessages(channelMessages.messages) }
                      : state.messagesByChannelId,
                    nextBeforeSeqByChannelId: activeChannelId && channelMessages
                      ? { ...state.nextBeforeSeqByChannelId, [activeChannelId]: channelMessages.nextBeforeSeq }
                      : state.nextBeforeSeqByChannelId,
                    threadsByRootId: thread
                      ? { ...state.threadsByRootId, [thread.root.id]: thread }
                      : state.threadsByRootId,
                  }));
                  for (const [directMessageId, seq] of directTargets) {
                    if ((pendingDirectTargets.get(directMessageId) ?? 0) <= seq) pendingDirectTargets.delete(directMessageId);
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

  selectDirectMessage: (directMessageId) => {
    const previous = get().activeTarget;
    const sameTarget = previous?.kind === 'direct-message' && previous.directMessageId === directMessageId;
    set({
      activeTarget: { kind: 'direct-message', directMessageId },
      activeCollection: null,
      openThreadId: null,
      agentProfileOpen: sameTarget ? get().agentProfileOpen : false,
    });
    const agentId = agentIdForDirectMessage(directMessageId);
    const messages = agentId ? useAgentStore.getState().directMessagesByAgentId[agentId] ?? [] : [];
    const latest = messages.length ? messages[messages.length - 1] : null;
    if (latest) {
      void get().markTargetRead(
        { kind: 'direct-message', directMessageId },
        latest.dmSeq,
        latest.id,
      );
    }
  },

  openCollection: (activeCollection) => set({ activeCollection, openThreadId: null, agentProfileOpen: false }),

  selectChannel: async (channelId) => {
    set({ activeTarget: { kind: 'channel', channelId }, activeCollection: null, openThreadId: null, agentProfileOpen: false, loading: true, error: null });
    try {
      const payload = await fetchChannelMessages(channelId);
      const messages = chronologicalMessages(payload.messages);
      set((state) => ({
        messagesByChannelId: {
          ...state.messagesByChannelId,
          [channelId]: messages,
        },
        nextBeforeSeqByChannelId: {
          ...state.nextBeforeSeqByChannelId,
          [channelId]: payload.nextBeforeSeq,
        },
      }));
      const latest = messages.length ? messages[messages.length - 1] : null;
      if (latest) {
        await get().markTargetRead(
          { kind: 'channel', channelId },
          latest.channelSeq,
          latest.id,
        );
      }
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error) });
    } finally {
      set({ loading: false });
    }
  },

  markTargetRead: async (target, seq, messageId = null) => {
    try {
      const payload = await markChatUnreadRead({ target, seq, messageId });
      set({ unread: payload.unread });
    } catch (error) {
      console.error('mark unread failed:', error);
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
          ...chronologicalMessages(payload.messages),
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

  toggleAgentProfile: () => set((state) => ({ agentProfileOpen: !state.agentProfileOpen })),

  closeAgentProfile: () => set({ agentProfileOpen: false }),

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
    : reference.target.kind === 'direct-message'
      && reference.target.directMessageId === target.directMessageId;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}
