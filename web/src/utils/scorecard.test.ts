import { describe, expect, it } from 'vitest';
import { Scorecard } from '../../../tradex/evolution/scorecard';
import type { DarwinWeightEntry, Recommendation } from '../../../tradex/evolution/types';

function rec(signal: Recommendation['signal'], return5d: number, conviction = 100): Recommendation {
  return {
    moduleId: 'ict_trader',
    instrumentKey: 'USDT-FUTURES:BTCUSDT',
    signal,
    conviction,
    priceAtRecommendation: 100,
    recommendedAt: '2026-05-28T00:00:00.000Z',
    return1d: null,
    return5d,
    return20d: null,
  };
}

function scoreFor(recommendations: Recommendation[]) {
  const weights: DarwinWeightEntry[] = [{
    moduleId: 'ict_trader',
    weight: 1.7,
    sharpe30d: null,
    hitRate30d: null,
    updatedAt: '2026-05-28T00:00:00.000Z',
  }];
  const store = {
    getDarwinWeights: () => weights,
    getModuleRecommendations: (moduleId: string) => moduleId === 'ict_trader' ? recommendations : [],
  };
  return new Scorecard(store as never).computeAll(30).find((score) => score.moduleId === 'ict_trader')!;
}

describe('Scorecard', () => {
  it('does not count NEUTRAL recommendations as automatic hits', () => {
    const score = scoreFor([
      rec('LONG', 0.02),
      rec('SHORT', 0.03),
      rec('NEUTRAL', 0),
    ]);

    expect(score.totalRecommendations).toBe(3);
    expect(score.hitRate30d).toBe(0.5);
  });

  it('flips short returns before scoring direction', () => {
    const score = scoreFor([
      rec('SHORT', -0.02),
      rec('SHORT', 0.01),
      rec('LONG', 0.03),
    ]);

    expect(score.hitRate30d).toBeCloseTo(2 / 3);
    expect(score.sharpe30d).toBeGreaterThan(0);
  });

  it('preserves the current Darwin weight from the store', () => {
    const score = scoreFor([rec('LONG', 0.02)]);
    expect(score.darwinWeight).toBe(1.7);
  });
});
