import { create } from 'zustand';
import { useShallow } from 'zustand/shallow';
import type { InstrumentCatalogItem, MarketState } from '../types';
import {
  connectStateSocket,
  fetchInstrumentCatalog,
  fetchState,
} from '../api';
import { orderedGroups } from '../utils';

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

export const useMarketStore = create<MarketStoreState>((set, get) => ({
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
    let disposed = false;
    let retryTimer: number | undefined;
    let socket: WebSocket | undefined;

    const scheduleReconnect = () => {
      if (disposed || retryTimer !== undefined) return;
      retryTimer = window.setTimeout(() => {
        retryTimer = undefined;
        openSocket();
      }, 1500);
    };

    const openSocket = () => {
      if (disposed) return;
      set({ socketStatus: 'connecting' });
      socket = connectStateSocket(
        (state) => set({ state }),
        (status) => {
          set({ socketStatus: status });
          if (status === 'disconnected' || status === 'error') {
            scheduleReconnect();
          }
        },
      );
    };

    fetchState().then((state) => set({ state })).catch(() => set({ socketStatus: 'error' }));
    set({ catalogStatus: 'loading' });
    fetchInstrumentCatalog()
      .then((payload) => get().setInstrumentCatalog(payload))
      .catch(() => set({ catalogStatus: 'error' }));
    openSocket();

    return () => {
      disposed = true;
      if (retryTimer !== undefined) window.clearTimeout(retryTimer);
      socket?.close();
    };
  },
}));

export function useGroups() {
  return useMarketStore(useShallow((s) => orderedGroups(s.state)));
}

