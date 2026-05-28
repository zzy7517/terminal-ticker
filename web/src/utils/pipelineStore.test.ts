import { describe, expect, it } from 'vitest';
import { usePipelineStore } from '../stores/pipelineStore';

describe('pipelineStore snapshot integration', () => {
  it('projects WebSocket snapshot fields into pipeline state', () => {
    usePipelineStore.setState({
      regime: null,
      feeds: {},
      darwinWeights: [],
      recentRuns: [],
      lastRunId: null,
    });

    usePipelineStore.getState().updateFromSnapshot({
      regime: {
        market: 'RISK_ON',
        volatility: 'LOW',
        trend: 'UP',
        indicators: { vix: null, adx: null, fearGreed: null, fundingRate: null, longShortRatio: null, oiDelta1h: null, dxy: null },
        detectedAt: '2026-05-28T00:00:00.000Z',
      },
      feeds: { fear_greed: { value: 72, classification: 'Greed', timestamp: 'now' } },
      darwinWeights: [{ moduleId: 'ict_trader', weight: 1.2, sharpe30d: null, hitRate30d: null, updatedAt: 'now' }],
      lastPipelineRun: { id: 'run-123' },
    });

    const state = usePipelineStore.getState();
    expect(state.regime?.market).toBe('RISK_ON');
    expect(state.feeds.fear_greed?.value).toBe(72);
    expect(state.darwinWeights).toHaveLength(1);
    expect(state.lastRunId).toBe('run-123');
  });

  it('clears optional snapshot projections when fields are absent', () => {
    usePipelineStore.getState().updateFromSnapshot({});
    const state = usePipelineStore.getState();
    expect(state.regime).toBeNull();
    expect(state.feeds).toEqual({});
    expect(state.darwinWeights).toEqual([]);
    expect(state.lastRunId).toBeNull();
  });
});
