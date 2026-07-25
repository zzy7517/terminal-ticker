import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ORIGIN_CONFIG,
  createOriginPreferencesAdapter,
} from './preferences';

function memoryStorage(initial?: string) {
  const values = new Map<string, string>();
  if (initial !== undefined) values.set('tradex-origin-preferences-v1', initial);
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
  };
}

describe('Origin preferences adapter', () => {
  it('stores only the last successful config and opened Session identity', () => {
    const preferences = createOriginPreferencesAdapter(memoryStorage());
    preferences.saveLastConfig({
      runtime: 'claude-code',
      provider: null,
      model: 'opus',
      reasoningEffort: 'high',
    });
    preferences.saveLastOpenedSessionId('origin-2');

    expect(preferences.load()).toEqual({
      lastConfig: {
        runtime: 'claude-code',
        provider: null,
        model: 'opus',
        reasoningEffort: 'high',
      },
      lastOpenedSessionId: 'origin-2',
    });
  });

  it('fails closed on corrupt or unexpected persisted values', () => {
    const preferences = createOriginPreferencesAdapter(memoryStorage(JSON.stringify({
      lastConfig: { runtime: 'unknown', provider: {}, model: 'x', reasoningEffort: null },
      lastOpenedSessionId: 42,
    })));

    expect(preferences.load()).toEqual({ lastConfig: null, lastOpenedSessionId: null });
    expect(DEFAULT_ORIGIN_CONFIG).toEqual({
      runtime: 'pi', provider: null, model: null, reasoningEffort: null,
    });
  });
});
