/**
 * RecommendationTracker — records module signals and back-fills forward returns.
 */

import type { EvolutionStore } from "./store.js";
import type { Recommendation } from "./types.js";
import type { ModuleRunResult } from "../pipeline/types.js";

export class RecommendationTracker {
  private store: EvolutionStore;

  constructor(store: EvolutionStore) {
    this.store = store;
  }

  /** Record all module outputs from a pipeline run. */
  recordFromPipelineRun(
    moduleResults: ModuleRunResult[],
    instrumentKey: string,
    currentPrice: number,
  ): void {
    const now = new Date().toISOString();
    for (const r of moduleResults) {
      if (r.error) continue; // skip errored modules
      this.store.insertRecommendation({
        moduleId: r.moduleId,
        instrumentKey,
        signal: r.output.signal,
        conviction: r.output.conviction,
        priceAtRecommendation: currentPrice,
        recommendedAt: now,
        return1d: null,
        return5d: null,
        return20d: null,
      });
    }
  }

  /**
   * Back-fill forward returns for past recommendations.
   * Call this periodically (e.g. every 4h) with a price getter.
   */
  async backfillReturns(
    getCurrentPrice: (instrumentKey: string) => number | null,
  ): Promise<number> {
    let filled = 0;

    // 1-day returns
    const recs1d = this.store.getUnfilledRecommendations("return_1d");
    for (const rec of recs1d) {
      const age = Date.now() - new Date(rec.recommendedAt).getTime();
      if (age < 24 * 3600_000) continue; // not yet 1 day old
      const price = getCurrentPrice(rec.instrumentKey);
      if (price === null) continue;
      const ret = (price - rec.priceAtRecommendation) / rec.priceAtRecommendation;
      this.store.updateReturn(rec.id!, "return_1d", ret);
      filled++;
    }

    // 5-day returns
    const recs5d = this.store.getUnfilledRecommendations("return_5d");
    for (const rec of recs5d) {
      const age = Date.now() - new Date(rec.recommendedAt).getTime();
      if (age < 5 * 24 * 3600_000) continue;
      const price = getCurrentPrice(rec.instrumentKey);
      if (price === null) continue;
      const ret = (price - rec.priceAtRecommendation) / rec.priceAtRecommendation;
      this.store.updateReturn(rec.id!, "return_5d", ret);
      filled++;
    }

    // 20-day returns
    const recs20d = this.store.getUnfilledRecommendations("return_20d");
    for (const rec of recs20d) {
      const age = Date.now() - new Date(rec.recommendedAt).getTime();
      if (age < 20 * 24 * 3600_000) continue;
      const price = getCurrentPrice(rec.instrumentKey);
      if (price === null) continue;
      const ret = (price - rec.priceAtRecommendation) / rec.priceAtRecommendation;
      this.store.updateReturn(rec.id!, "return_20d", ret);
      filled++;
    }

    return filled;
  }
}
