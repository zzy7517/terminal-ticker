import { create } from 'zustand';
import type { AppRoute } from '../constants';
import { readRouteFromHash, navigateToRoute } from '../utils';

export type WorkspaceViewId =
  | 'agent'
  | 'market'
  | 'news'
  | 'social'
  | 'calendar'
  | 'positions'
  | 'options'
  | 'cron';

interface UiState {
  route: AppRoute;
  activeWorkspace: WorkspaceViewId;
  watchlistOpen: boolean;
  selectedKey: string | null;
  activeGroup: string | null;

  setRoute: (route: AppRoute) => void;
  setActiveWorkspace: (view: WorkspaceViewId) => void;
  toggleWatchlist: () => void;
  setWatchlistOpen: (open: boolean) => void;
  setSelectedKey: (key: string | null) => void;
  setActiveGroup: (group: string | null) => void;
  openSettings: (section?: string) => void;
  openWorkspace: () => void;
}

export const useUiStore = create<UiState>((set) => ({
  route: readRouteFromHash(),
  activeWorkspace: 'agent',
  watchlistOpen: false,
  selectedKey: null,
  activeGroup: null,

  setRoute: (route) => set({ route }),
  setActiveWorkspace: (activeWorkspace) => set({ activeWorkspace }),
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
