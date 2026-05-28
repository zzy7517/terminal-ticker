import { describe, expect, it } from 'vitest';
import { PipelineOrchestrator } from '../../../tradex/pipeline/orchestrator';
import { PromptComposer } from '../../../tradex/pipeline/prompt_composer';
import type { PipelineRun, RegimeSignal } from '../../../tradex/pipeline/types';

const regime: RegimeSignal = {
  market: 'RISK_ON',
  volatility: 'MEDIUM',
  trend: 'UP',
  indicators: {
    vix: 14,
    adx: 28,
    fearGreed: 62,
    fundingRate: 0.0001,
    longShortRatio: 1.2,
    oiDelta1h: 1_000_000,
    dxy: 103,
  },
  detectedAt: '2026-05-28T00:00:00.000Z',
};

describe('PipelineOrchestrator smoke', () => {
  it('runs module analysis, CRO, synthesis, and onComplete with mocked LLM', async () => {
    const completed: PipelineRun[] = [];
    const orchestrator = new PipelineOrchestrator({
      regimeDetector: { detect: () => regime } as never,
      promptComposer: new PromptComposer(),
      llmCall: async (_systemPrompt, userPrompt) => {
        if (userPrompt.includes('候选交易决策')) {
          return {
            tokensUsed: 20,
            content: JSON.stringify({
              approved: true,
              objections: [],
              reflexivity_flags: [],
              risk_level: 'LOW',
              adjusted_conviction: 78,
              reasoning: 'risk accepted',
            }),
          };
        }
        return {
          tokensUsed: 100,
          content: JSON.stringify({
            signal: 'LONG',
            conviction: 80,
            entry: 100,
            stop_loss: 95,
            take_profit: 112,
            key_levels: { support: [95], resistance: [112] },
            reasoning: 'aligned long setup',
          }),
        };
      },
      getCandleData: () => '2026-05-28T00:00:00.000Z O:99 H:101 L:98 C:100 V:1000',
      getCurrentPrice: () => 100,
      getDarwinWeights: () => [
        { moduleId: 'ict_trader', weight: 1.2, sharpe30d: null, hitRate30d: null, updatedAt: regime.detectedAt },
      ],
      getFundamentalContext: () => 'Funding Rate: 0.0100%',
      getFundingRate: () => 0.0001,
      getLongShortRatio: () => 1.2,
      getOIDelta: () => 1_000_000,
      onComplete: (run) => completed.push(run),
    });

    const run = await orchestrator.run('USDT-FUTURES:BTCUSDT', 'manual');

    expect(run.status).toBe('completed');
    expect(run.moduleResults).toHaveLength(5);
    expect(run.decision?.action).toBe('OPEN_LONG');
    expect(run.decision?.survivedCRO).toBe(true);
    expect(run.decision?.riskRewardRatio).toBe(2.4);
    expect(run.totalTokens).toBe(500);
    expect(orchestrator.lastRun?.id).toBe(run.id);
    expect(completed).toEqual([run]);
  });

  it('persists failed runs through onComplete before rethrowing', async () => {
    const completed: PipelineRun[] = [];
    const orchestrator = new PipelineOrchestrator({
      regimeDetector: { detect: () => { throw new Error('regime unavailable'); } } as never,
      promptComposer: new PromptComposer(),
      llmCall: async () => ({ content: '{}', tokensUsed: 0 }),
      getCandleData: () => '',
      getCurrentPrice: () => null,
      getDarwinWeights: () => [],
      getFundamentalContext: () => '',
      getFundingRate: () => null,
      getLongShortRatio: () => null,
      getOIDelta: () => null,
      onComplete: (run) => completed.push(run),
    });

    await expect(orchestrator.run('USDT-FUTURES:BTCUSDT', 'manual')).rejects.toThrow('regime unavailable');
    expect(completed).toHaveLength(1);
    expect(completed[0].status).toBe('failed');
    expect(orchestrator.lastRun?.status).toBe('failed');
  });
});
