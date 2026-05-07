import { create } from 'zustand';
import type { AppRoute, ThemeName } from '../constants';
import { THEME_STORAGE_KEY } from '../constants';
import { readInitialTheme, readRouteFromHash, navigateToRoute, nextTheme } from '../utils';

interface UiState {
  route: AppRoute;
  theme: ThemeName;
  sidebarCollapsed: boolean;
  selectedKey: string | null;
  activeGroup: string | null;
  analysisIntervalBusy: boolean;
  olderBusyKey: string | null;
  exhaustedHistoryKeys: Set<string>;

  setRoute: (route: AppRoute) => void;
  toggleTheme: () => void;
  setTheme: (theme: ThemeName) => void;
  setSidebarCollapsed: (value: boolean) => void;
  setSelectedKey: (key: string | null) => void;
  setActiveGroup: (group: string | null) => void;
  setAnalysisIntervalBusy: (busy: boolean) => void;
  setOlderBusyKey: (key: string | null) => void;
  markHistoryExhausted: (key: string) => void;
  clearHistoryExhausted: (key: string) => void;
  openSettings: (section?: string) => void;
  openWorkspace: () => void;
}

export const useUiStore = create<UiState>((set, get) => ({
  route: readRouteFromHash(),
  theme: readInitialTheme(),
  sidebarCollapsed: false,
  selectedKey: null,
  activeGroup: null,
  analysisIntervalBusy: false,
  olderBusyKey: null,
  exhaustedHistoryKeys: new Set(),

  setRoute: (route) => set({ route }),
  toggleTheme: () => {
    const next = nextTheme(get().theme);
    document.documentElement.dataset.theme = next;
    try { window.localStorage.setItem(THEME_STORAGE_KEY, next); } catch {}
    set({ theme: next });
  },
  setTheme: (theme) => {
    document.documentElement.dataset.theme = theme;
    try { window.localStorage.setItem(THEME_STORAGE_KEY, theme); } catch {}
    set({ theme });
  },
  setSidebarCollapsed: (value) => set({ sidebarCollapsed: value }),
  setSelectedKey: (key) => set({ selectedKey: key }),
  setActiveGroup: (group) => set({ activeGroup: group }),
  setAnalysisIntervalBusy: (busy) => set({ analysisIntervalBusy: busy }),
  setOlderBusyKey: (key) => set({ olderBusyKey: key }),
  markHistoryExhausted: (key) => set((s) => {
    const next = new Set(s.exhaustedHistoryKeys);
    next.add(key);
    return { exhaustedHistoryKeys: next };
  }),
  clearHistoryExhausted: (key) => set((s) => {
    const next = new Set(s.exhaustedHistoryKeys);
    next.delete(key);
    return { exhaustedHistoryKeys: next };
  }),
  openSettings: (section = 'providers') => {
    navigateToRoute({ view: 'settings', section: section as any });
  },
  openWorkspace: () => {
    navigateToRoute({ view: 'workspace' });
  },
}));
