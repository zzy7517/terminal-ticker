import {
  AGENT_CONTEXT_HASH,
  AGENTS_HASH,
  APPEARANCE_HASH,
  BROWSER_HASH,
  CRON_HASH,
  MCP_HASH,
  NEWS_HASH,
  JIN10_HASH,
  OPTIONS_HASH,
  PROVIDERS_HASH,
  PROXY_HASH,
  WATCHLIST_HASH,
  type AppRoute,
} from '../constants';

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
  if (window.location.hash.startsWith(JIN10_HASH)) {
    return { view: 'settings', section: 'jin10' };
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
        : route.section === 'jin10'
        ? JIN10_HASH
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
