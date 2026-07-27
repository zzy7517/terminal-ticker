/** Agent 私信（Direct Message）与 reaction 的 zustand slice。 */
import type { StoreApi } from 'zustand';
import { chronologicalMessages } from '../../chat/timeline';
import { fetchAgentDirectMessages, setDirectMessageReaction } from '../../api';
import type { AgentDirectMessage } from '../../types';
import type { AgentState } from '../agentStore';

type StoreSet = StoreApi<AgentState>['setState'];
type StoreGet = StoreApi<AgentState>['getState'];

export interface DirectMessagesSlice {
  directMessageIdByAgentId: Record<string, string>;
  directMessagesByAgentId: Record<string, AgentDirectMessage[]>;
  refreshAgentDirectMessages: (agentId: string) => Promise<void>;
  toggleDirectMessageReaction: (agentId: string, messageId: string, emoji: string) => Promise<void>;
}

export function createDirectMessagesSlice(set: StoreSet, get: StoreGet): DirectMessagesSlice {
  return {
    directMessageIdByAgentId: {},
    directMessagesByAgentId: {},

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
  };
}
