export const GROUP_LABELS: Record<string, string> = {
  bitget: 'Bitget',
  hyperliquid: 'Hyperliquid',
  jin10: 'Jin10',
  crypto: 'Crypto',
  stocks: 'Stocks',
  indices: 'Indices',
  commodities: 'Commodities',
  fx: 'FX',
  preipo: 'Pre-IPO',
};

export const PROVIDERS_HASH = '#/settings/providers';
export const AGENT_CONTEXT_HASH = '#/settings/agent-context';
export const AGENTS_HASH = '#/settings/agents';
export const WATCHLIST_HASH = '#/settings/watchlist';
export const NEWS_HASH = '#/settings/news';
export const MEMORY_HASH = '#/settings/memory';
export const CRON_HASH = '#/settings/cron';
export const MCP_HASH = '#/settings/mcp';
export const BROWSER_HASH = '#/settings/browser';
export const OPTIONS_HASH = '#/settings/options';
export const PROXY_HASH = '#/settings/proxy';

export const ANALYSIS_INTERVAL_OPTIONS = ['1m', '3m', '5m', '15m', '30m', '1H', '4H', '1D', '1W', '1M'];
export type SettingsSection = 'providers' | 'agents' | 'agent-context' | 'watchlist' | 'news' | 'memory' | 'cron' | 'mcp' | 'browser' | 'options' | 'proxy';
export type SearchSource = 'bitget' | 'hyperliquid';
export type SourceHint = SearchSource;
export type AppRoute =
  | { view: 'workspace' }
  | { view: 'settings'; section: SettingsSection };
