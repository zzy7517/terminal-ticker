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
  {
    provider: 'openai',
    label: 'OpenAI',
    apiMode: 'openai_completions',
    defaultModel: 'gpt-4o',
    description: 'Chat Completions adapter (OpenAI / LiteLLM)',
    detail: 'OpenAI Chat Completions adapter. Point Base URL at any OpenAI-compatible endpoint — a LiteLLM proxy, Ollama, vLLM, or OpenAI itself.',
    supportsReasoning: false,
  },
] as const;

// Providers that talk an OpenAI/Anthropic-compatible wire format and therefore
// support a custom Base URL + manually-entered model IDs in the settings UI.
export const PROVIDERS_WITH_CUSTOM_ENDPOINT = new Set(['anthropic', 'openai']);
export const PROVIDERS_HASH = '#/settings/providers';
export const AGENT_CONTEXT_HASH = '#/settings/agent-context';
export const WATCHLIST_HASH = '#/settings/watchlist';
export const NEWS_HASH = '#/settings/news';
export const MEMORY_HASH = '#/settings/memory';
export const SOCIAL_HASH = '#/settings/social';
export const CRON_HASH = '#/settings/cron';
export const MCP_HASH = '#/settings/mcp';
export const BROWSER_HASH = '#/settings/browser';
export const OPTIONS_HASH = '#/settings/options';

export const ANALYSIS_INTERVAL_OPTIONS = ['1m', '3m', '5m', '15m', '30m', '1H', '4H', '1D', '1W', '1M'];
export type SettingsSection = 'providers' | 'agent-context' | 'watchlist' | 'news' | 'memory' | 'social' | 'cron' | 'mcp' | 'browser' | 'options';
export type SearchSource = 'bitget' | 'hyperliquid';
export type SourceHint = SearchSource;
export type AppRoute =
  | { view: 'workspace' }
  | { view: 'settings'; section: SettingsSection };
