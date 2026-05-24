import type {
  Instrument,
  InstrumentSearchResult,
  MarketState,
  Quote,
} from './types';
import {
  AGENT_CONTEXT_HASH,
  BROWSER_HASH,
  CRON_HASH,
  MCP_HASH,
  MEMORY_HASH,
  NEWS_HASH,
  PROVIDERS_HASH,
  SOCIAL_HASH,
  THEME_STORAGE_KEY,
  WATCHLIST_HASH,
  type AppRoute,
  type ThemeName,
} from './constants';
import {
  addBitgetSymbol,
  addHyperliquidSymbol,
} from './api';

export function readInitialTheme(): ThemeName {
  try {
    return window.localStorage.getItem(THEME_STORAGE_KEY) === 'dark' ? 'dark' : 'light';
  } catch {
    return 'light';
  }
}

export function nextTheme(theme: ThemeName): ThemeName {
  return theme === 'dark' ? 'light' : 'dark';
}

export function readRouteFromHash(): AppRoute {
  if (window.location.hash.startsWith(BROWSER_HASH)) {
    return { view: 'settings', section: 'browser' };
  }
  if (window.location.hash.startsWith(MCP_HASH)) {
    return { view: 'settings', section: 'mcp' };
  }
  if (window.location.hash.startsWith(CRON_HASH)) {
    return { view: 'settings', section: 'cron' };
  }
  if (window.location.hash.startsWith(SOCIAL_HASH)) {
    return { view: 'settings', section: 'social' };
  }
  if (window.location.hash.startsWith(MEMORY_HASH)) {
    return { view: 'settings', section: 'memory' };
  }
  if (window.location.hash.startsWith(AGENT_CONTEXT_HASH)) {
    return { view: 'settings', section: 'agent-context' };
  }
  if (window.location.hash.startsWith(NEWS_HASH)) {
    return { view: 'settings', section: 'news' };
  }
  if (window.location.hash.startsWith(WATCHLIST_HASH)) {
    return { view: 'settings', section: 'watchlist' };
  }
  if (window.location.hash.startsWith(PROVIDERS_HASH)) {
    return { view: 'settings', section: 'providers' };
  }
  return { view: 'workspace' };
}

export function navigateToRoute(route: AppRoute) {
  if (route.view === 'settings') {
    const hash =
      route.section === 'cron'
        ? CRON_HASH
        : route.section === 'social'
        ? SOCIAL_HASH
        : route.section === 'memory'
        ? MEMORY_HASH
        : route.section === 'agent-context'
        ? AGENT_CONTEXT_HASH
        : route.section === 'news'
        ? NEWS_HASH
        : route.section === 'watchlist'
          ? WATCHLIST_HASH
          : route.section === 'mcp'
            ? MCP_HASH
            : route.section === 'browser'
              ? BROWSER_HASH
              : PROVIDERS_HASH;
    window.location.hash = hash;
    return;
  }
  if (window.location.hash) {
    history.replaceState(null, '', `${window.location.pathname}${window.location.search}`);
    window.dispatchEvent(new Event('hashchange'));
  }
}

export function orderedGroups(state: MarketState | null) {
  if (!state) return [];
  const preferred = ['bitget', 'hyperliquid'];
  const present = Object.keys(state.groups);
  return [
    ...preferred.filter((group) => present.includes(group)),
    ...present.filter((group) => !preferred.includes(group)).sort(),
  ];
}

export function changeClass(quote: Quote | undefined) {
  if (!quote || quote.change == null) return 'neutral';
  if (quote.change > 0) return 'up';
  if (quote.change < 0) return 'down';
  return 'neutral';
}

export function sourceName(source: string) {
  if (source === 'hyperliquid') return 'Hyperliquid';
  return source.toUpperCase();
}

export function addInstrumentBySource(result: InstrumentSearchResult) {
  if (result.source === 'bitget') return addBitgetSymbol(result);
  return addHyperliquidSymbol(result);
}

export function formatContextWindow(size: number | null) {
  if (size == null) return '-';
  if (size >= 1000) return `${Math.round(size / 1000)}K`;
  return String(size);
}
