import { create } from 'zustand';
import type { AppRoute } from '../constants';
import { isAvatarStyle, type AvatarStyle } from '../avatar/avatar';
import { readRouteFromHash, navigateToRoute } from '../utils/routeHash';

export type WorkspaceViewId =
  | 'agent'
  | 'market'
  | 'news'
  | 'calendar'
  | 'positions'
  | 'options'
  | 'macro'
  | 'cron';

export type Theme = 'light' | 'dark';

const THEME_STORAGE_KEY = 'tradex-theme';
const AVATAR_STYLE_STORAGE_KEY = 'tradex-avatar-style';

function loadTheme(): Theme {
  try {
    return window.localStorage.getItem(THEME_STORAGE_KEY) === 'light' ? 'light' : 'dark';
  } catch {
    return 'dark';
  }
}

function applyTheme(theme: Theme): void {
  if (typeof document !== 'undefined') document.documentElement.dataset.theme = theme;
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {}
}

function loadAvatarStyle(): AvatarStyle {
  try {
    const raw = window.localStorage.getItem(AVATAR_STYLE_STORAGE_KEY);
    return isAvatarStyle(raw) ? raw : 'beam';
  } catch {
    return 'beam';
  }
}

function persistAvatarStyle(style: AvatarStyle): void {
  try {
    window.localStorage.setItem(AVATAR_STYLE_STORAGE_KEY, style);
  } catch {}
}

interface UiState {
  route: AppRoute;
  activeWorkspace: WorkspaceViewId;
  theme: Theme;
  avatarStyle: AvatarStyle;
  watchlistOpen: boolean;
  selectedKey: string | null;
  activeGroup: string | null;

  setRoute: (route: AppRoute) => void;
  setActiveWorkspace: (view: WorkspaceViewId) => void;
  setTheme: (theme: Theme) => void;
  toggleTheme: () => void;
  setAvatarStyle: (style: AvatarStyle) => void;
  toggleWatchlist: () => void;
  setWatchlistOpen: (open: boolean) => void;
  setSelectedKey: (key: string | null) => void;
  setActiveGroup: (group: string | null) => void;
  openSettings: (section?: string) => void;
  openWorkspace: () => void;
}

const initialTheme = loadTheme();
applyTheme(initialTheme);
const initialAvatarStyle = loadAvatarStyle();

export const useUiStore = create<UiState>((set, get) => ({
  route: readRouteFromHash(),
  activeWorkspace: 'agent',
  theme: initialTheme,
  avatarStyle: initialAvatarStyle,
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
  setAvatarStyle: (avatarStyle) => {
    persistAvatarStyle(avatarStyle);
    set({ avatarStyle });
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
