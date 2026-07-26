import type {
  InstrumentSearchResult,
  MarketState,
  Quote,
} from './types';
import {
  AGENT_CONTEXT_HASH,
  AGENTS_HASH,
  APPEARANCE_HASH,
  BROWSER_HASH,
  CRON_HASH,
  MCP_HASH,
  NEWS_HASH,
  OPTIONS_HASH,
  PROVIDERS_HASH,
  PROXY_HASH,
  WATCHLIST_HASH,
  type AppRoute,
} from './constants';
import {
  addBitgetSymbol,
  addHyperliquidSymbol,
} from './api';

export function readRouteFromHash(): AppRoute {
  if (typeof window === 'undefined') return { view: 'workspace' };
  if (window.location.hash.startsWith(AGENTS_HASH)) return { view: 'settings', section: 'agents' };
  if (window.location.hash.startsWith(APPEARANCE_HASH)) return { view: 'settings', section: 'appearance' };
  if (window.location.hash.startsWith(PROXY_HASH)) {
    return { view: 'settings', section: 'proxy' };
  }
  if (window.location.hash.startsWith(OPTIONS_HASH)) {
    return { view: 'settings', section: 'options' };
  }
  if (window.location.hash.startsWith(BROWSER_HASH)) {
    return { view: 'settings', section: 'browser' };
  }
  if (window.location.hash.startsWith(MCP_HASH)) {
    return { view: 'settings', section: 'mcp' };
  }
  if (window.location.hash.startsWith(CRON_HASH)) {
    return { view: 'settings', section: 'cron' };
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
        : route.section === 'agents'
        ? AGENTS_HASH
        : route.section === 'appearance'
        ? APPEARANCE_HASH
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
              : route.section === 'options'
                ? OPTIONS_HASH
                : route.section === 'proxy'
                  ? PROXY_HASH
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
