/**
 * Scorecard — computes Sharpe ratio and hit rate for each module.
 */

import type { EvolutionStore } from "./store.js";
import type { ModuleScore, Recommendation } from "./types.js";
import { DEFAULT_MODULE_IDS } from "./types.js";

export class Scorecard {
  private store: EvolutionStore;

  constructor(store: EvolutionStore) {
    this.store = store;
  }

  /** Compute scores for all modules. */
  computeAll(days = 30): ModuleScore[] {
    const weights = this.store.getDarwinWeights();
    const weightMap = new Map(weights.map((w) => [w.moduleId, w]));

    return DEFAULT_MODULE_IDS.map((moduleId) => {
      const recs = this.store.getModuleRecommendations(moduleId, days);
      const scored = recs.filter((r) => r.return5d !== null && r.signal !== "NEUTRAL");
      const sharpe = this.computeSharpe(scored);
      const hitRate = this.computeHitRate(scored);
      const existing = weightMap.get(moduleId);

      return {
        moduleId,
        darwinWeight: existing?.weight ?? 1.0,
        sharpe30d: sharpe,
        hitRate30d: hitRate,
        totalRecommendations: recs.length,
        modificationsAttempted: 0, // filled separately
        modificationsKept: 0,
        lastModifiedAt: null,
        updatedAt: new Date().toISOString(),
      };
    });
  }

  /** Sharpe ratio of conviction-weighted returns. */
  private computeSharpe(recs: Recommendation[]): number {
    if (recs.length < 3) return 0;

    const returns = recs.map((r) => {
      const ret = r.return5d!;
      const weight = r.conviction / 100;
      // Flip sign for SHORT
      const directionalReturn = r.signal === "SHORT" ? -ret : ret;
      return directionalReturn * weight;
    });

    const mean = returns.reduce((s, v) => s + v, 0) / returns.length;
    const variance = returns.reduce((s, v) => s + (v - mean) ** 2, 0) / (returns.length - 1);
    const stdDev = Math.sqrt(variance);

    if (stdDev === 0) return 0;
    // Annualize (assume ~1 recommendation per day)
    return (mean / stdDev) * Math.sqrt(252);
  }

  /** Hit rate: fraction of correct-direction predictions. */
  private computeHitRate(recs: Recommendation[]): number {
    if (recs.length === 0) return 0;

    let hits = 0;
    for (const r of recs) {
      const ret = r.return5d!;
      if (r.signal === "LONG" && ret > 0) hits++;
      else if (r.signal === "SHORT" && ret < 0) hits++;
    }
    return hits / recs.length;
  }
}
