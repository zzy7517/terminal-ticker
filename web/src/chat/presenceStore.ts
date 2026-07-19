/**
 * presenceStore — Agent 在线/忙碌 presence 投影（一轮轮询，多处订阅）。
 *
 * 未读数仍在 chatStore；本模块只负责 Agent presence（对应 Raft 状态点）。
 */
import { useEffect } from 'react';
import { create } from 'zustand';
import { fetchAgentPresence } from '../api';
import type { AgentPresence } from '../types';

interface PresenceState {
  byAgentId: Record<string, AgentPresence>;
  lastError: string | null;
  subscribers: number;
  timer: ReturnType<typeof setInterval> | null;
  refresh: () => Promise<void>;
  subscribe: () => () => void;
}

const POLL_MS = 3_000;

/** Agent presence Zustand Store（引用计数启停轮询）。 */
export const usePresenceStore = create<PresenceState>((set, get) => ({
  byAgentId: {},
  lastError: null,
  subscribers: 0,
  timer: null,

  refresh: async () => {
    try {
      const payload = await fetchAgentPresence();
      const next: Record<string, AgentPresence> = {};
      for (const entry of payload.agents) next[entry.agentId] = entry;
      set({ byAgentId: next, lastError: null });
    } catch (error) {
      set({ lastError: error instanceof Error ? error.message : String(error) });
    }
  },

  subscribe: () => {
    const state = get();
    const subscribers = state.subscribers + 1;
    set({ subscribers });
    if (subscribers === 1) {
      void get().refresh();
      const timer = setInterval(() => void get().refresh(), POLL_MS);
      set({ timer });
    }
    return () => {
      const next = get().subscribers - 1;
      set({ subscribers: Math.max(0, next) });
      if (next <= 0) {
        const timer = get().timer;
        if (timer) clearInterval(timer);
        set({ timer: null });
      }
    };
  },
}));

/** React hook：面板生命周期内订阅，返回 presence 映射。 */
export function useChatPresence(): Record<string, AgentPresence> {
  const byAgentId = usePresenceStore((s) => s.byAgentId);
  const subscribe = usePresenceStore((s) => s.subscribe);
  useEffect(() => subscribe(), [subscribe]);
  return byAgentId;
}
