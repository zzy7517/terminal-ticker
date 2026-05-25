import { describe, expect, it } from 'vitest';
import {
  contextTokenCount,
  contextUsagePercent,
  fallbackContextWindow,
  formatContextPercent,
  resolveContextWindow,
} from './contextUsage';

describe('context usage helpers', () => {
  it('falls back to known model-family context windows when cache metadata is missing', () => {
    expect(resolveContextWindow('codex', 'gpt-5.4-mini', {})).toBe(128_000);
    expect(resolveContextWindow('anthropic', 'global.anthropic.claude-opus-4-6-v1', {})).toBe(200_000);
  });

  it('prefers provider cache metadata over family fallback values', () => {
    expect(resolveContextWindow('Codex', 'gpt-5.4-mini', {
      codex: [{
        slug: 'gpt-5.4-mini',
        displayName: 'GPT 5.4 Mini',
        description: '',
        visibility: 'public',
        supportedInApi: true,
        defaultReasoningEffort: 'medium',
        supportedReasoningEfforts: ['medium'],
        contextWindow: 256_000,
        preferWebsockets: false,
      }],
    })).toBe(256_000);
  });

  it('uses the best available token count and computes percent', () => {
    expect(contextTokenCount({ tokens: 64_000, promptTokens: 1, totalTokens: 2 })).toBe(64_000);
    expect(contextUsagePercent({ percent: -1, promptTokens: 32_000 }, 128_000)).toBe(25);
    expect(contextUsagePercent({ promptTokens: 32_000, totalTokens: 33_000 }, 128_000)).toBe(25);
    expect(contextUsagePercent({ tokens: 10_000, contextWindow: 200_000 }, null)).toBe(5);
  });

  it('formats tiny and whole percentages for compact display', () => {
    expect(formatContextPercent(0.4)).toBe('<1');
    expect(formatContextPercent(70.49)).toBe('70');
    expect(fallbackContextWindow('unknown', 'unknown-model')).toBeNull();
  });
});
