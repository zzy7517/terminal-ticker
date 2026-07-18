import { create } from 'zustand';
import { createChannel, fetchChannelMessages, fetchChannels, sendChannelMessage } from '../api';
import type { Channel, ChannelMessage } from '../types';

interface ChatState {
  channels: Channel[];
  activeChannelId: string | null;
  messagesByChannelId: Record<string, ChannelMessage[]>;
  loading: boolean;
  sending: boolean;
  error: string | null;
  initChannels: () => Promise<void>;
  openDirectMessages: () => void;
  selectChannel: (channelId: string) => Promise<void>;
  createChannel: (name: string) => Promise<void>;
  sendMessage: (content: string) => Promise<void>;
}

export const useChatStore = create<ChatState>((set, get) => ({
  channels: [],
  activeChannelId: null,
  messagesByChannelId: {},
  loading: false,
  sending: false,
  error: null,

  initChannels: async () => {
    set({ loading: true, error: null });
    try {
      const payload = await fetchChannels();
      set({ channels: payload.channels });
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error) });
    } finally {
      set({ loading: false });
    }
  },

  openDirectMessages: () => set({ activeChannelId: null }),

  selectChannel: async (channelId) => {
    set({ activeChannelId: channelId, loading: true, error: null });
    try {
      const payload = await fetchChannelMessages(channelId);
      set((state) => ({
        messagesByChannelId: {
          ...state.messagesByChannelId,
          [channelId]: [...payload.messages].reverse(),
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
      set({ channels: payload.channels, activeChannelId: payload.channel.id });
      await get().selectChannel(payload.channel.id);
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error) });
    } finally {
      set({ loading: false });
    }
  },

  sendMessage: async (content) => {
    const channelId = get().activeChannelId;
    const clean = content.trim();
    if (!channelId || !clean || get().sending) return;
    set({ sending: true, error: null });
    try {
      const payload = await sendChannelMessage(channelId, clean);
      set((state) => ({
        channels: state.channels.map((channel) => channel.id === payload.channel.id ? payload.channel : channel),
        messagesByChannelId: {
          ...state.messagesByChannelId,
          [channelId]: [...(state.messagesByChannelId[channelId] ?? []), payload.message],
        },
      }));
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error) });
    } finally {
      set({ sending: false });
    }
  },
}));
