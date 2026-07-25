import type { OriginDraftConfig } from '../../types';

const STORAGE_KEY = 'tradex-origin-preferences-v1';

export const DEFAULT_ORIGIN_CONFIG: OriginDraftConfig = {
  runtime: 'pi',
  provider: null,
  model: null,
  reasoningEffort: null,
};

export interface OriginPreferencesSnapshot {
  lastConfig: OriginDraftConfig | null;
  lastOpenedSessionId: string | null;
}

export interface OriginPreferencesAdapter {
  load(): OriginPreferencesSnapshot;
  saveLastConfig(config: OriginDraftConfig): void;
  saveLastOpenedSessionId(sessionId: string | null): void;
}

interface PreferenceStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const EMPTY_PREFERENCES: OriginPreferencesSnapshot = {
  lastConfig: null,
  lastOpenedSessionId: null,
};

/** LocalStorage adapter; passing storage creates a deterministic in-memory test seam. */
export function createOriginPreferencesAdapter(
  storage?: PreferenceStorage | null,
): OriginPreferencesAdapter {
  const resolveStorage = () => storage === undefined ? browserStorage() : storage;
  const load = (): OriginPreferencesSnapshot => readPreferences(resolveStorage());
  const write = (next: OriginPreferencesSnapshot): void => {
    try {
      resolveStorage()?.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch {}
  };

  return {
    load,
    saveLastConfig: (config) => write({ ...load(), lastConfig: cloneConfig(config) }),
    saveLastOpenedSessionId: (sessionId) => write({
      ...load(),
      lastOpenedSessionId: cleanSessionId(sessionId),
    }),
  };
}

export const originPreferences = createOriginPreferencesAdapter();

function readPreferences(storage: PreferenceStorage | null): OriginPreferencesSnapshot {
  try {
    const raw = storage?.getItem(STORAGE_KEY);
    if (!raw) return { ...EMPTY_PREFERENCES };
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed)) return { ...EMPTY_PREFERENCES };
    return {
      lastConfig: parseConfig(parsed.lastConfig),
      lastOpenedSessionId: cleanSessionId(parsed.lastOpenedSessionId),
    };
  } catch {
    return { ...EMPTY_PREFERENCES };
  }
}

function parseConfig(value: unknown): OriginDraftConfig | null {
  if (!isRecord(value) || !isRuntime(value.runtime)) return null;
  const provider = nullableString(value.provider);
  const model = nullableString(value.model);
  const reasoningEffort = nullableString(value.reasoningEffort);
  if (provider === undefined || model === undefined || reasoningEffort === undefined) return null;
  return { runtime: value.runtime, provider, model, reasoningEffort };
}

function cloneConfig(config: OriginDraftConfig): OriginDraftConfig {
  return {
    runtime: config.runtime,
    provider: config.provider,
    model: config.model,
    reasoningEffort: config.reasoningEffort,
  };
}

function nullableString(value: unknown): string | null | undefined {
  if (value === null) return null;
  if (typeof value !== 'string') return undefined;
  return value.trim() || null;
}

function cleanSessionId(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function isRuntime(value: unknown): value is OriginDraftConfig['runtime'] {
  return value === 'pi' || value === 'claude-code' || value === 'cursor';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function browserStorage(): PreferenceStorage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}
