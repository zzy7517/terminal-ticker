import { describe, expect, it } from 'vitest';
import { pipelineRoutes } from '../../../tradex/api/routes/pipeline';
import { evolutionRoutes } from '../../../tradex/api/routes/evolution';
import { feedsRoutes } from '../../../tradex/api/routes/feeds';

describe('API route query bounds', () => {
  it('clamps pipeline runs limit and offset', async () => {
    let captured: unknown = null;
    const app = pipelineRoutes({
      pipelineStore: {
        listRuns: (opts: unknown) => {
          captured = opts;
          return [];
        },
      },
      pipelineOrchestrator: null,
    } as never);

    const res = await app.request('/api/pipeline/runs?limit=9999&offset=-10&instrument=BTC');
    expect(res.status).toBe(200);
    expect(captured).toEqual({ instrumentKey: 'BTC', limit: 100, offset: 0 });
  });

  it('clamps evolution history, modification, and recommendation query windows', async () => {
    const calls: Array<[string, unknown[]]> = [];
    const app = evolutionRoutes({
      evolutionStore: {
        getDarwinWeights: () => [],
        getWeightHistory: (...args: unknown[]) => { calls.push(['history', args]); return []; },
        listModifications: (...args: unknown[]) => { calls.push(['mods', args]); return []; },
        getModuleRecommendations: (...args: unknown[]) => { calls.push(['recs', args]); return []; },
      },
    } as never);

    expect((await app.request('/api/evolution/weights/history/ict_trader?limit=9999')).status).toBe(200);
    expect((await app.request('/api/evolution/modifications?limit=-5')).status).toBe(200);
    expect((await app.request('/api/evolution/recommendations/ict_trader?days=9999')).status).toBe(200);

    expect(calls).toEqual([
      ['history', ['ict_trader', 365]],
      ['mods', [1]],
      ['recs', ['ict_trader', 365]],
    ]);
  });

  it('clamps feed history limits before calling feed history', async () => {
    let capturedLimit = 0;
    const app = feedsRoutes({
      dataFeeds: {
        get: (name: string) => name === 'funding'
          ? {
              getLatest: () => null,
              getHistory: (limit: number) => {
                capturedLimit = limit;
                return [];
              },
            }
          : null,
      },
    } as never);

    const res = await app.request('/api/feeds/funding/history?limit=9999');
    expect(res.status).toBe(200);
    expect(capturedLimit).toBe(500);
  });
});
