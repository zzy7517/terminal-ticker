export const GROUP_LABELS: Record<string, string> = {
  bitget: 'Bitget',
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
export const JIN10_HASH = '#/settings/jin10';
export const CRON_HASH = '#/settings/cron';
export const MCP_HASH = '#/settings/mcp';
export const BROWSER_HASH = '#/settings/browser';
export const OPTIONS_HASH = '#/settings/options';
export const PROXY_HASH = '#/settings/proxy';
export const APPEARANCE_HASH = '#/settings/appearance';

export type SettingsSection = 'providers' | 'agents' | 'agent-context' | 'appearance' | 'watchlist' | 'news' | 'jin10' | 'cron' | 'mcp' | 'browser' | 'options' | 'proxy';
export type AppRoute =
  | { view: 'workspace' }
  | { view: 'settings'; section: SettingsSection };
