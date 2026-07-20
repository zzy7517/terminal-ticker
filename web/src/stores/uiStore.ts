import { create } from 'zustand';
import type { AppRoute } from '../constants';
import { readRouteFromHash, navigateToRoute } from '../utils';

export type WorkspaceViewId =
  | 'agent'
  | 'market'
  | 'news'
  | 'calendar'
  | 'positions'
  | 'options'
  | 'cron';

export type Theme = 'light' | 'dark';

const THEME_STORAGE_KEY = 'tradex-theme';

function loadTheme(): Theme {
  try {
    return window.localStorage.getItem(THEME_STORAGE_KEY) === 'light' ? 'light' : 'dark';
  } catch {
    return 'dark';
  }
}

function applyTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme;
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {}
}

interface UiState {
  route: AppRoute;
  activeWorkspace: WorkspaceViewId;
  theme: Theme;
  watchlistOpen: boolean;
  selectedKey: string | null;
  activeGroup: string | null;

  setRoute: (route: AppRoute) => void;
  setActiveWorkspace: (view: WorkspaceViewId) => void;
  setTheme: (theme: Theme) => void;
  toggleTheme: () => void;
  toggleWatchlist: () => void;
  setWatchlistOpen: (open: boolean) => void;
  setSelectedKey: (key: string | null) => void;
  setActiveGroup: (group: string | null) => void;
  openSettings: (section?: string) => void;
  openWorkspace: () => void;
}

const initialTheme = loadTheme();
applyTheme(initialTheme);

export const useUiStore = create<UiState>((set, get) => ({
  route: readRouteFromHash(),
  activeWorkspace: 'agent',
  theme: initialTheme,
  watchlistOpen: false,
  selectedKey: null,
  activeGroup: null,

  setRoute: (route) => set({ route }),
  setActiveWorkspace: (activeWorkspace) => set({ activeWorkspace }),
  setTheme: (theme) => {
    applyTheme(theme);
    set({ theme });
  },
  toggleTheme: () => get().setTheme(get().theme === 'light' ? 'dark' : 'light'),
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
