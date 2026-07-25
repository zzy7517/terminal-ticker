/**
 * chatStore — 前端 Chat 壳状态（对应 Raft Chat：Channels + 未读）。
 *
 * 管理 Channel 列表/消息、活动目标与未读游标；
 * Agent DM timeline 仍由 agentStore 持有，本 Store 只协调 Chat 壳导航。
 */
import { create } from 'zustand';
import {
  connectChatEvents,
  createChannel,
  fetchChannelMessages,
  fetchChatBootstrap,
  markChatUnreadRead,
  sendChannelMessage,
  setChannelReaction,
} from '../api';
import type { Channel, ChannelMessage, ChatSurfaceTarget, ChatTarget, ChatUnreadEntry } from '../types';
import { agentIdForDirectMessage, recoverDirectMessageTarget } from '../chat/directMessageWorkspace';
import { chronologicalMessages } from '../chat/timeline';
import { useAgentStore } from './agentStore';

/** Chat 壳 Zustand 状态：Channel / 未读 / 活动目标。 */
interface ChatState {
  channels: Channel[];
  activeTarget: ChatSurfaceTarget | null;
  messagesByChannelId: Record<string, ChannelMessage[]>;
  nextBeforeSeqByChannelId: Record<string, number | null>;
  unread: ChatUnreadEntry[];
  agentProfileOpen: boolean;
  lastEventSeq: number;
  eventStatus: 'connected' | 'disconnected' | 'error';
  loading: boolean;
  sending: boolean;
  error: string | null;
  initChat: () => () => void;
  selectDirectMessage: (directMessageId: string) => void;
  selectOrigin: (sessionId: string) => void;
  leaveOrigin: () => void;
  selectChannel: (channelId: string) => Promise<void>;
  loadOlderMessages: () => Promise<void>;
  createChannel: (name: string) => Promise<void>;
  sendMessage: (content: string) => Promise<void>;
  toggleAgentProfile: () => void;
  closeAgentProfile: () => void;
  toggleReaction: (message: ChannelMessage, emoji: string) => Promise<void>;
  markTargetRead: (target: ChatTarget, seq: number, messageId?: string | null) => Promise<void>;
}

/** Human Chat 壳 Store：bootstrap、选中目标、发消息、未读。 */
export const useChatStore = create<ChatState>((set, get) => ({
  channels: [],
  activeTarget: null,
  messagesByChannelId: {},
  nextBeforeSeqByChannelId: {},
  unread: [],
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
                  const [channelMessages] = await Promise.all([
                    activeChannelId ? fetchChannelMessages(activeChannelId) : Promise.resolve(null),
                    ...[...directTargets.keys()].map((directMessageId) => recoverDirectMessageTarget(directMessageId)),
                  ]);
                  if (disposed) break;
                  const channelTimeline = activeChannelId && channelMessages
                    ? chronologicalMessages(channelMessages.messages)
                    : null;
                  set((state) => ({
                    channels: snapshot.channels,
                    unread: snapshot.unread ?? state.unread,
                    lastEventSeq: snapshot.lastEventSeq,
                    error: null,
                    messagesByChannelId: activeChannelId && channelTimeline
                      ? { ...state.messagesByChannelId, [activeChannelId]: channelTimeline }
                      : state.messagesByChannelId,
                    nextBeforeSeqByChannelId: activeChannelId && channelMessages
                      ? { ...state.nextBeforeSeqByChannelId, [activeChannelId]: channelMessages.nextBeforeSeq }
                      : state.nextBeforeSeqByChannelId,
                  }));
                  // Viewing a target counts as read; advance cursor after the snapshot
                  // so a later mark-read response is not overwritten by stale unread.
                  await markActiveTargetReadAfterRecovery({
                    activeTarget: get().activeTarget,
                    recoveredChannelId: activeChannelId,
                    channelTimeline,
                    recoveredDirectMessageIds: [...directTargets.keys()],
                    markTargetRead: get().markTargetRead,
                  });
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

  selectOrigin: (sessionId) => set({
    activeTarget: { kind: 'origin', sessionId },
    agentProfileOpen: false,
  }),

  leaveOrigin: () => set((state) => ({
    activeTarget: state.activeTarget?.kind === 'origin' ? null : state.activeTarget,
  })),

  selectChannel: async (channelId) => {
    set({ activeTarget: { kind: 'channel', channelId }, agentProfileOpen: false, loading: true, error: null });
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

  sendMessage: async (content) => {
    const target = get().activeTarget;
    const clean = content.trim();
    if (target?.kind !== 'channel' || !clean || get().sending) return;
    set({ sending: true, error: null });
    try {
      const payload = await sendChannelMessage(target.channelId, clean);
      set((state) => ({
        channels: replaceChannel(state.channels, payload.channel),
        messagesByChannelId: {
          ...state.messagesByChannelId,
          [target.channelId]: [...(state.messagesByChannelId[target.channelId] ?? []), payload.message],
        },
      }));
      await get().markTargetRead(target, payload.message.channelSeq, payload.message.id);
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error) });
    } finally {
      set({ sending: false });
    }
  },

  toggleAgentProfile: () => set((state) => ({ agentProfileOpen: !state.agentProfileOpen })),

  closeAgentProfile: () => set({ agentProfileOpen: false }),

  toggleReaction: async (message, emoji) => {
    const active = !message.reactions.some((reaction) => reaction.emoji === emoji && reaction.reacted);
    try {
      const payload = await setChannelReaction(message.id, emoji, active);
      set((state) => updateMessageState(state, payload.message, payload.channel));
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
  return {
    channels: replaceChannel(state.channels, channel),
    messagesByChannelId: replaceMessage(state.messagesByChannelId, message.channelId, message),
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

/** SSE 恢复后：若用户正看着该 target，推进已读游标。 */
export async function markActiveTargetReadAfterRecovery(input: {
  activeTarget: ChatSurfaceTarget | null;
  /** 本次恢复实际拉取的 Channel；与 activeTarget 不一致时不得推进已读。 */
  recoveredChannelId: string | null;
  channelTimeline: ChannelMessage[] | null;
  recoveredDirectMessageIds: string[];
  markTargetRead: (target: ChatTarget, seq: number, messageId?: string | null) => Promise<void>;
}): Promise<void> {
  const active = input.activeTarget;
  if (!active) return;
  if (active.kind === 'origin') return;
  if (active.kind === 'channel') {
    // Recovery may outlive a target switch; never apply channel A's timeline to channel B.
    if (!input.recoveredChannelId || active.channelId !== input.recoveredChannelId) return;
    const timeline = input.channelTimeline;
    const latest = timeline?.length ? timeline[timeline.length - 1] : null;
    if (latest) await input.markTargetRead(active, latest.channelSeq, latest.id);
    return;
  }
  if (!input.recoveredDirectMessageIds.includes(active.directMessageId)) return;
  const agentId = agentIdForDirectMessage(active.directMessageId);
  const messages = agentId ? useAgentStore.getState().directMessagesByAgentId[agentId] ?? [] : [];
  const latest = messages.length ? messages[messages.length - 1] : null;
  if (latest) await input.markTargetRead(active, latest.dmSeq, latest.id);
}
