import { create } from 'zustand';
import type { AppRoute, ThemeName } from '../constants';
import { THEME_STORAGE_KEY } from '../constants';
import { readInitialTheme, readRouteFromHash, navigateToRoute, nextTheme } from '../utils';

interface UiState {
  route: AppRoute;
  theme: ThemeName;
  watchlistOpen: boolean;
  selectedKey: string | null;
  activeGroup: string | null;

  setRoute: (route: AppRoute) => void;
  toggleTheme: () => void;
  setTheme: (theme: ThemeName) => void;
  toggleWatchlist: () => void;
  setWatchlistOpen: (open: boolean) => void;
  setSelectedKey: (key: string | null) => void;
  setActiveGroup: (group: string | null) => void;
  openSettings: (section?: string) => void;
  openWorkspace: () => void;
}

export const useUiStore = create<UiState>((set, get) => ({
  route: readRouteFromHash(),
  theme: readInitialTheme(),
  watchlistOpen: false,
  selectedKey: null,
  activeGroup: null,

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
  toggleWatchlist: () => set((s) => ({ watchlistOpen: !s.watchlistOpen })),
  setWatchlistOpen: (open) => set({ watchlistOpen: open }),
  setSelectedKey: (key) => set({ selectedKey: key }),
  setActiveGroup: (group) => set({ activeGroup: group }),
  openSettings: (section = 'providers') => {
    navigateToRoute({ view: 'settings', section: section as any });
  },
  openWorkspace: () => {
    navigateToRoute({ view: 'workspace' });
  },
}));
