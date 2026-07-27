import { create } from 'zustand';
import { useShallow } from 'zustand/shallow';
import type { InstrumentCatalogItem, MarketState } from '../types';
import {
  connectStateSocket,
  fetchInstrumentCatalog,
  fetchState,
} from '../api';
import { orderedGroups } from '../utils/marketDisplay';

const SOCKET_RECONNECT_DELAY_MS = 1500;
const SOCKET_TEARDOWN_GRACE_MS = 250;

interface MarketStoreState {
  state: MarketState | null;
  instrumentCatalog: InstrumentCatalogItem[];
  catalogLoadedAt: string | null;
  catalogErrors: Record<string, string>;
  catalogStatus: 'idle' | 'loading' | 'ready' | 'error';
  socketStatus: string;

  setState: (state: MarketState) => void;
  setInstrumentCatalog: (payload: {
    items: InstrumentCatalogItem[];
    loadedAt: string | null;
    errors: Record<string, string>;
  }) => void;
  setSocketStatus: (status: string) => void;
  initSocket: () => () => void;
}

export const useMarketStore = create<MarketStoreState>((set, get) => {
  let activeSubscribers = 0;
  let initialized = false;
  let retryTimer: number | undefined;
  let teardownTimer: number | undefined;
  let socket: WebSocket | undefined;
  let socketGeneration = 0;

  const clearRetry = () => {
    if (retryTimer === undefined) return;
    window.clearTimeout(retryTimer);
    retryTimer = undefined;
  };

  const clearTeardown = () => {
    if (teardownTimer === undefined) return;
    window.clearTimeout(teardownTimer);
    teardownTimer = undefined;
  };

  const scheduleReconnect = () => {
    if (!initialized || activeSubscribers === 0 || retryTimer !== undefined) return;
    retryTimer = window.setTimeout(() => {
      retryTimer = undefined;
      openSocket();
    }, SOCKET_RECONNECT_DELAY_MS);
  };

  const openSocket = () => {
    if (!initialized || activeSubscribers === 0) return;
    const generation = ++socketGeneration;
    set({ socketStatus: 'connecting' });
    socket = connectStateSocket(
      (state) => set({ state }),
      (status) => {
        if (generation !== socketGeneration) return;
        set({ socketStatus: status });
        if (status === 'disconnected' || status === 'error') {
          scheduleReconnect();
        }
      },
    );
  };

  const start = () => {
    if (initialized) return;
    initialized = true;
    fetchState().then((state) => set({ state })).catch(() => set({ socketStatus: 'error' }));
    set({ catalogStatus: 'loading' });
    fetchInstrumentCatalog()
      .then((payload) => get().setInstrumentCatalog(payload))
      .catch(() => set({ catalogStatus: 'error' }));
    openSocket();
  };

  const stop = () => {
    if (!initialized) return;
    initialized = false;
    socketGeneration += 1;
    clearRetry();
    socket?.close();
    socket = undefined;
  };

  return {
    state: null,
    instrumentCatalog: [],
    catalogLoadedAt: null,
    catalogErrors: {},
    catalogStatus: 'idle',
    socketStatus: 'connecting',

    setState: (state) => set({ state }),
    setInstrumentCatalog: (payload) => set({
      instrumentCatalog: payload.items,
      catalogLoadedAt: payload.loadedAt,
      catalogErrors: payload.errors,
      catalogStatus: Object.keys(payload.errors).length ? 'error' : 'ready',
    }),
    setSocketStatus: (status) => set({ socketStatus: status }),

    initSocket: () => {
      activeSubscribers += 1;
      clearTeardown();
      start();

      return () => {
        activeSubscribers = Math.max(0, activeSubscribers - 1);
        if (activeSubscribers > 0 || teardownTimer !== undefined) return;
        teardownTimer = window.setTimeout(() => {
          teardownTimer = undefined;
          if (activeSubscribers === 0) stop();
        }, SOCKET_TEARDOWN_GRACE_MS);
      };
    },
  };
});

export function useGroups() {
  return useMarketStore(useShallow((s) => orderedGroups(s.state)));
}

