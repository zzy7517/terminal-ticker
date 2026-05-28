/**
 * Darwin weight updater — adjusts module weights based on performance.
 *
 * Top quartile: weight × 1.05
 * Bottom quartile: weight × 0.95
 * Bounds: [0.3, 2.5]
 */

import type { EvolutionStore } from "./store.js";
import { Scorecard } from "./scorecard.js";
import { MIN_DARWIN_WEIGHT, MAX_DARWIN_WEIGHT, WEIGHT_GROWTH_FACTOR, WEIGHT_DECAY_FACTOR } from "./types.js";

export class DarwinWeightUpdater {
  private store: EvolutionStore;
  private scorecard: Scorecard;

  constructor(store: EvolutionStore) {
    this.store = store;
    this.scorecard = new Scorecard(store);
  }

  /** Run daily weight update. Returns the updated scores. */
  update(): { moduleId: string; oldWeight: number; newWeight: number; sharpe: number }[] {
    const scores = this.scorecard.computeAll(30);
    const changes: { moduleId: string; oldWeight: number; newWeight: number; sharpe: number }[] = [];

    if (scores.length < 2) return changes;

    // Sort by Sharpe descending
    const sorted = [...scores].sort((a, b) => b.sharpe30d - a.sharpe30d);
    const quarter = Math.max(1, Math.ceil(sorted.length / 4));

    const topIds = new Set(sorted.slice(0, quarter).map((s) => s.moduleId));
    const bottomIds = new Set(sorted.slice(-quarter).map((s) => s.moduleId));

    for (const score of scores) {
      const oldWeight = score.darwinWeight;
      let newWeight = oldWeight;

      if (topIds.has(score.moduleId)) {
        newWeight = Math.min(MAX_DARWIN_WEIGHT, oldWeight * WEIGHT_GROWTH_FACTOR);
      } else if (bottomIds.has(score.moduleId)) {
        newWeight = Math.max(MIN_DARWIN_WEIGHT, oldWeight * WEIGHT_DECAY_FACTOR);
      }

      // Round to 3 decimal places
      newWeight = Math.round(newWeight * 1000) / 1000;

      this.store.updateDarwinWeight(score.moduleId, newWeight, score.sharpe30d, score.hitRate30d);
      changes.push({ moduleId: score.moduleId, oldWeight, newWeight, sharpe: score.sharpe30d });
    }

    return changes;
  }
}
