export const GROUP_LABELS: Record<string, string> = {
  bitget: 'Bitget',
  hyperliquid: 'Hyperliquid',
  crypto: 'Crypto',
  stocks: 'Stocks',
  indices: 'Indices',
  commodities: 'Commodities',
  fx: 'FX',
  preipo: 'Pre-IPO',
};

export const REASONING_OPTIONS = ['low', 'medium', 'high', 'xhigh'];
export const DEFAULT_ANTHROPIC_MODEL = 'global.anthropic.claude-opus-4-6-v1';
export const AGENT_PROVIDER_OPTIONS = [
  {
    provider: 'codex',
    label: 'Codex',
    apiMode: 'codex_responses',
    defaultModel: 'gpt-5.4-mini',
    description: 'Responses adapter for market analysis',
    detail: 'Codex Responses adapter used by the local agent for structured commentary and watch-plan output.',
    supportsReasoning: true,
  },
  {
    provider: 'anthropic',
    label: 'Anthropic',
    apiMode: 'anthropic_messages',
    defaultModel: DEFAULT_ANTHROPIC_MODEL,
    description: 'Messages adapter via x-api-key',
    detail: 'Anthropic Messages adapter used by the local agent through the official or custom endpoint.',
    supportsReasoning: false,
  },
] as const;
export const PROVIDERS_HASH = '#/settings/providers';
export const AGENT_CONTEXT_HASH = '#/settings/agent-context';
export const WATCHLIST_HASH = '#/settings/watchlist';
export const NEWS_HASH = '#/settings/news';
export const MEMORY_HASH = '#/settings/memory';
export const SOCIAL_HASH = '#/settings/social';
export const CRON_HASH = '#/settings/cron';
export const MCP_HASH = '#/settings/mcp';
export const THEME_STORAGE_KEY = 'tradex-theme';
export const ANALYSIS_INTERVAL_OPTIONS = ['1m', '3m', '5m', '15m', '30m', '1H', '4H', '1D', '1W', '1M'];
export type SettingsSection = 'providers' | 'agent-context' | 'watchlist' | 'news' | 'memory' | 'social' | 'cron' | 'mcp';
export type SearchSource = 'bitget' | 'hyperliquid';
export type SourceHint = SearchSource;
export type ThemeName = 'light' | 'dark';

export type AppRoute =
  | { view: 'workspace' }
  | { view: 'settings'; section: SettingsSection };

export const THEME_LABELS: Record<ThemeName, string> = {
  light: 'Light',
  dark: 'Dark',
};
