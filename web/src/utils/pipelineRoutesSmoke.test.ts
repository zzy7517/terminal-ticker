import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { pipelineRoutes } from '../../../tradex/api/routes/pipeline';
import { evolutionRoutes } from '../../../tradex/api/routes/evolution';
import { feedsRoutes } from '../../../tradex/api/routes/feeds';

describe('pipeline route smoke', () => {
  it('uses one mock runtime across trigger, run history, feeds, and evolution endpoints', async () => {
    const runs: Array<Record<string, unknown>> = [];
    const runtime: any = {
      pipelineOrchestrator: { currentRegime: null, isRunning: false },
      pipelineStore: {
        listRuns: () => runs,
        getRun: (id: string) => runs.find((run) => run.id === id) ?? null,
      },
      runPipeline: async (instrumentKey: string, trigger: string) => {
        const run = {
          id: `run-${runs.length + 1}`,
          instrumentKey,
          triggeredBy: trigger,
          status: 'completed',
          decision: { action: 'PASS' },
        };
        runs.unshift(run);
        runtime.pipelineOrchestrator.currentRegime = { market: 'NEUTRAL', volatility: 'MEDIUM', trend: 'RANGE' };
        return run;
      },
      evolutionStore: {
        getDarwinWeights: () => [{ moduleId: 'ict_trader', weight: 1, sharpe30d: null, hitRate30d: null, updatedAt: 'now' }],
        getWeightHistory: () => [],
        listModifications: () => [],
        getModuleRecommendations: () => [],
      },
      dataFeeds: {
        statuses: () => [{ name: 'fear_greed', dataAge: 1, lastFetchedAt: 'now', lastError: null }],
        snapshot: () => ({ fear_greed: { value: 50, classification: 'Neutral', timestamp: 'now' } }),
        get: (name: string) => name === 'fear_greed'
          ? {
              getLatest: () => ({ value: 50, classification: 'Neutral', timestamp: 'now' }),
              getHistory: () => [{ value: 50, classification: 'Neutral', timestamp: 'now' }],
            }
          : null,
      },
    };

    const app = new Hono();
    app.route('', pipelineRoutes(runtime as never));
    app.route('', evolutionRoutes(runtime as never));
    app.route('', feedsRoutes(runtime as never));

    const trigger = await app.request('/api/pipeline/trigger', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ instrumentKey: 'USDT-FUTURES:BTCUSDT' }),
    });
    expect(trigger.status).toBe(200);
    await expect(trigger.json()).resolves.toMatchObject({ run: { id: 'run-1', status: 'completed' } });

    const runList = await app.request('/api/pipeline/runs');
    await expect(runList.json()).resolves.toMatchObject({ runs: [{ id: 'run-1' }] });

    const runDetail = await app.request('/api/pipeline/runs/run-1');
    await expect(runDetail.json()).resolves.toMatchObject({ run: { id: 'run-1' } });

    const regime = await app.request('/api/pipeline/regime');
    await expect(regime.json()).resolves.toMatchObject({ regime: { market: 'NEUTRAL' } });

    const scorecard = await app.request('/api/evolution/scorecard');
    await expect(scorecard.json()).resolves.toMatchObject({ modules: [{ moduleId: 'ict_trader', weight: 1 }] });

    const feedStatus = await app.request('/api/feeds/status');
    await expect(feedStatus.json()).resolves.toMatchObject({ feeds: [{ name: 'fear_greed' }] });

    const feedLatest = await app.request('/api/feeds/fear_greed/latest');
    await expect(feedLatest.json()).resolves.toMatchObject({ data: { value: 50 } });
  });
});
