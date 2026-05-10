import { ColorType } from 'lightweight-charts';

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
    description: 'Responses adapter for chart analysis',
    detail: 'Codex Responses adapter used by the chart agent for structured commentary and watch-plan output.',
    supportsReasoning: true,
  },
  {
    provider: 'anthropic',
    label: 'Anthropic',
    apiMode: 'anthropic_messages',
    defaultModel: DEFAULT_ANTHROPIC_MODEL,
    description: 'Messages adapter via x-api-key',
    detail: 'Anthropic Messages adapter used by the chart agent through the official or custom endpoint.',
    supportsReasoning: false,
  },
] as const;
export const PROVIDERS_HASH = '#/settings/providers';
export const AGENT_CONTEXT_HASH = '#/settings/agent-context';
export const WATCHLIST_HASH = '#/settings/watchlist';
export const NEWS_HASH = '#/settings/news';
export const MEMORY_HASH = '#/settings/memory';
export const SOCIAL_HASH = '#/settings/social';
export const THEME_STORAGE_KEY = 'mytradebot-theme';
export const ANALYSIS_INTERVAL_OPTIONS = ['1m', '3m', '5m', '15m', '30m', '1H', '4H', '1D', '1W', '1M'];
export type SettingsSection = 'providers' | 'agent-context' | 'watchlist' | 'news' | 'memory' | 'social';
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

export const CHART_THEMES = {
  light: {
    chart: {
      layout: {
        background: { type: ColorType.Solid, color: '#fbfcfb' },
        textColor: 'rgba(39, 49, 49, 0.64)',
        fontFamily: 'Aptos, "Avenir Next", "Segoe UI", sans-serif',
      },
      grid: {
        vertLines: { color: 'rgba(42, 66, 70, 0.07)' },
        horzLines: { color: 'rgba(42, 66, 70, 0.09)' },
      },
      rightPriceScale: {
        borderColor: 'rgba(42, 66, 70, 0.14)',
        scaleMargins: { top: 0.12, bottom: 0.14 },
      },
      timeScale: {
        borderColor: 'rgba(42, 66, 70, 0.14)',
        timeVisible: true,
        secondsVisible: false,
      },
      crosshair: {
        vertLine: { color: 'rgba(15, 124, 144, 0.38)' },
        horzLine: { color: 'rgba(15, 124, 144, 0.38)' },
      },
    },
    series: {
      upColor: '#2e9a66',
      downColor: '#c65047',
      wickUpColor: '#25885b',
      wickDownColor: '#b3433d',
      borderVisible: false,
    },
  },
  dark: {
    chart: {
      layout: {
        background: { type: ColorType.Solid, color: '#0e0f11' },
        textColor: 'rgba(186, 193, 204, 0.72)',
        fontFamily: 'Aptos, "Avenir Next", "Segoe UI", sans-serif',
      },
      grid: {
        vertLines: { color: 'rgba(255, 255, 255, 0.05)' },
        horzLines: { color: 'rgba(255, 255, 255, 0.06)' },
      },
      rightPriceScale: {
        borderColor: 'rgba(255, 255, 255, 0.08)',
        scaleMargins: { top: 0.12, bottom: 0.14 },
      },
      timeScale: {
        borderColor: 'rgba(255, 255, 255, 0.08)',
        timeVisible: true,
        secondsVisible: false,
      },
      crosshair: {
        vertLine: { color: 'rgba(79, 140, 255, 0.42)' },
        horzLine: { color: 'rgba(79, 140, 255, 0.42)' },
      },
    },
    series: {
      upColor: '#00b076',
      downColor: '#ff4466',
      wickUpColor: '#00b076',
      wickDownColor: '#ff4466',
      borderVisible: false,
    },
  },
};
