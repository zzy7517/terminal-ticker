import { create } from 'zustand';
import { useShallow } from 'zustand/shallow';
import type { InstrumentCatalogItem, MarketState } from '../types';
import {
  connectStateSocket,
  fetchInstrumentCatalog,
  fetchState,
  loadOlderCandles,
  saveInstrumentAnalysisInterval,
} from '../api';
import { orderedGroups } from '../utils';
import { useUiStore } from './uiStore';

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
  updateAnalysisInterval: (interval: string) => Promise<void>;
  loadOlderForSelected: () => Promise<void>;
}

const olderBusyRef = { current: null as string | null };

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

  updateAnalysisInterval: async (interval) => {
    const { state } = get();
    const ui = useUiStore.getState();
    const { selectedKey, analysisIntervalBusy } = ui;
    const selectedInstrument = state?.instruments.find((i) => i.key === selectedKey);
    if (!state || !selectedKey || interval === selectedInstrument?.analysisInterval || analysisIntervalBusy) return;
    ui.setAnalysisIntervalBusy(true);
    try {
      const nextState = await saveInstrumentAnalysisInterval(selectedKey, interval);
      set({ state: nextState });
    } catch (error) {
      console.error(error);
    } finally {
      ui.setAnalysisIntervalBusy(false);
    }
  },

  loadOlderForSelected: async () => {
    const { state } = get();
    const ui = useUiStore.getState();
    const { selectedKey, exhaustedHistoryKeys } = ui;
    const selectedInstrument = state?.instruments.find((i) => i.key === selectedKey);
    const currentInterval = selectedInstrument?.analysisInterval ?? state?.config.analysis.interval ?? '5m';
    const historyKey = selectedKey ? `${selectedKey}:${currentInterval}` : null;

    if (
      !selectedKey || !selectedInstrument || !historyKey ||
      olderBusyRef.current === historyKey ||
      exhaustedHistoryKeys.has(historyKey) ||
      !['bitget', 'hyperliquid'].includes(selectedInstrument.source)
    ) return;

    olderBusyRef.current = historyKey;
    ui.setOlderBusyKey(historyKey);
    try {
      const payload = await loadOlderCandles(selectedKey);
      set({ state: payload.state });
      if (payload.added === 0) {
        ui.markHistoryExhausted(historyKey);
      } else {
        ui.clearHistoryExhausted(historyKey);
      }
    } catch (error) {
      console.error(error);
    } finally {
      olderBusyRef.current = null;
      ui.setOlderBusyKey(null);
    }
  },
}));

export function useGroups() {
  return useMarketStore(useShallow((s) => orderedGroups(s.state)));
}

export function useSelectedInstrument() {
  const instruments = useMarketStore((s) => s.state?.instruments);
  const selectedKey = useUiStore((s) => s.selectedKey);
  return instruments?.find((i) => i.key === selectedKey);
}

export function useSelectedQuote() {
  const quotes = useMarketStore((s) => s.state?.quotes);
  const selectedKey = useUiStore((s) => s.selectedKey);
  return selectedKey && quotes ? quotes[selectedKey] : undefined;
}
