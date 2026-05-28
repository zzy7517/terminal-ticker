import { describe, expect, it } from 'vitest';
import { Synthesizer } from '../../../tradex/pipeline/synthesizer';
import type { ModuleRunResult, RegimeSignal } from '../../../tradex/pipeline/types';

const regime: RegimeSignal = {
  market: 'NEUTRAL',
  volatility: 'MEDIUM',
  trend: 'RANGE',
  indicators: {
    vix: null,
    adx: null,
    fearGreed: null,
    fundingRate: null,
    longShortRatio: null,
    oiDelta1h: null,
    dxy: null,
  },
  detectedAt: '2026-05-28T00:00:00.000Z',
};

function result(moduleId: string, signal: 'LONG' | 'SHORT' | 'NEUTRAL', conviction: number, weight: number): ModuleRunResult {
  return {
    moduleId,
    darwinWeight: weight,
    output: {
      moduleId,
      signal,
      conviction,
      entry: signal === 'NEUTRAL' ? null : 100,
      stopLoss: signal === 'LONG' ? 95 : signal === 'SHORT' ? 105 : null,
      takeProfit: signal === 'LONG' ? 112 : signal === 'SHORT' ? 88 : null,
      keyLevels: { support: [], resistance: [] },
      reasoning: `${moduleId} says ${signal}`,
    },
    tokensUsed: 10,
    durationMs: 5,
    error: null,
  };
}

describe('Synthesizer', () => {
  it('uses Darwin weights to choose the dominant signal', () => {
    const output = new Synthesizer().synthesize({
      regime,
      instrumentKey: 'USDT-FUTURES:BTCUSDT',
      currentPrice: 100,
      moduleResults: [
        result('low_weight_long_a', 'LONG', 90, 0.3),
        result('low_weight_long_b', 'LONG', 80, 0.3),
        result('high_weight_short', 'SHORT', 70, 2.0),
      ],
    });

    expect(output.aggregatedSignal).toBe('SHORT');
    expect(output.modulesAgreeing).toBe(1);
    expect(output.weightedConviction).toBe(70);
  });

  it('only averages conviction from modules agreeing with the winning signal', () => {
    const output = new Synthesizer().synthesize({
      regime,
      instrumentKey: 'USDT-FUTURES:BTCUSDT',
      currentPrice: 100,
      moduleResults: [
        result('long_a', 'LONG', 80, 1),
        result('long_b', 'LONG', 60, 1),
        result('short_high_conviction_loser', 'SHORT', 100, 0.5),
      ],
    });

    expect(output.aggregatedSignal).toBe('LONG');
    expect(output.weightedConviction).toBe(70);
  });

  it('discounts conviction in high-volatility regimes', () => {
    const output = new Synthesizer().synthesize({
      regime: { ...regime, volatility: 'HIGH' },
      instrumentKey: 'USDT-FUTURES:BTCUSDT',
      currentPrice: 100,
      moduleResults: [result('long', 'LONG', 100, 1)],
    });

    expect(output.weightedConviction).toBe(80);
  });
});
