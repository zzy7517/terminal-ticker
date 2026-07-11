import { describe, expect, it } from 'vitest';
import {
  contextTokenCount,
  contextUsagePercent,
  formatContextPercent,
  resolveContextWindow,
} from './contextUsage';

describe('context usage helpers', () => {
  it('reads context windows from registry metadata', () => {
    expect(resolveContextWindow('provider-a', 'model-a', {
      generation: 1,
      providers: [],
      models: [{
        providerId: 'provider-a',
        id: 'model-a',
        name: 'Model A',
        api: 'test-api',
        reasoning: true,
        input: ['text'],
        contextWindow: 256_000,
        maxTokens: 8_192,
        selected: true,
        source: 'pi',
        runnable: true,
      }],
    })).toBe(256_000);
    expect(resolveContextWindow('unknown', 'unknown-model', null)).toBeNull();
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
  });
});
