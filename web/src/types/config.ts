/** Provider profile、Agent/News/Proxy 配置更新 DTO。 */

export interface ProviderProfileState {
  enabled: boolean;
  api: string;
  displayName: string;
  requiresAuth: boolean;
  models: string[];
  modelEfforts: Record<string, string>;
  baseUrl?: string;
  apiKeyConfigured?: boolean;
  apiKeyFromEnv?: boolean;
  customModels?: string[];
  customModelDefinitions?: CustomModelDefinition[];
}

export interface CustomModelDefinition {
  id: string;
  name: string;
  api: string;
  reasoning: boolean;
  input: Array<'text' | 'image'>;
  contextWindow: number;
  maxTokens: number;
}

export interface AgentConfig {
  enabled: boolean;
  provider: string;
  apiMode: string;
  model: string;
  systemPrompt: string;
  maxCandles: number;
  candleContextMode: "raw" | "with_indicators";
  reasoningEffort: string;
  providerProfiles: Record<string, ProviderProfileState>;
}

export interface AgentConfigUpdate {
  enabled: boolean;
  systemPrompt: string;
  maxCandles: number;
  candleContextMode: "raw" | "with_indicators";
}

export interface ProviderProfileUpdate {
  enabled?: boolean;
  api?: string;
  displayName?: string;
  requiresAuth?: boolean;
  models?: string[];
  toggleModel?: string;
  modelEffort?: { model: string; effort: string };
  reasoningEffort?: string;
  apiKey?: string;
  baseUrl?: string;
  clearApiKey?: boolean;
  addCustomModel?: string;
  removeCustomModel?: string;
  customModelDefinitions?: CustomModelDefinition[];
}

export interface AnalysisConfigUpdate {
  enabled?: boolean;
  interval?: string;
  lookback?: number;
  pollIntervalSeconds?: number;
  staleAfterSeconds?: number;
}

export interface NewsConfigUpdate {
  enabled?: boolean;
  pollIntervalSeconds?: number;
  maxIntervalSeconds?: number;
  reutersUrl?: string;
  forexfactoryEnabled?: boolean;
  requestTimeoutSeconds?: number;
  retentionDays?: number;
  recentLimit?: number;
}

export type ProxyType = 'http' | 'https' | 'socks5';

export interface ProxyConfigPayload {
  enabled: boolean;
  type: ProxyType;
  host: string;
  port: number;
  username: string;
  passwordConfigured: boolean;
}

export interface ProxyConfigUpdate {
  enabled?: boolean;
  type?: ProxyType;
  host?: string;
  port?: number;
  username?: string;
  password?: string;
  clearPassword?: boolean;
}

export interface ProxyTestResult {
  ok: boolean;
  url?: string | null;
  status?: number;
  latencyMs?: number;
  error?: string;
}

export interface OptionsConfigUpdate {
  enabled?: boolean;
  provider?: 'yfinance' | 'tradier' | 'deribit' | 'marketdata';
  symbols?: string[];
  pollIntervalSeconds?: number;
  strikeRangePercent?: number;
  tradier?: { apiKey?: string; baseUrl?: string };
  marketdata?: { apiKey?: string; baseUrl?: string; strikeLimit?: number | null; dte?: number | null; callsPerMinute?: number | null };
  deribit?: { enabled?: boolean; currencies?: string[] };
}

export interface BrowserStatus {
  enabled: boolean;
  connected: boolean;
  socketPath: string | null;
  error: string | null;
}

export interface BrowserPingResult {
  ok: boolean;
  info?: unknown;
  error?: string;
}
