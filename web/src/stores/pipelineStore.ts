/**
 * Pipeline & Evolution state — derived from WebSocket snapshot + REST.
 */

import { create } from "zustand";
import type { RegimeSignal, PipelineRunSummary, DarwinWeightEntry, FeedsSnapshot } from "../types";

interface PipelineState {
  regime: RegimeSignal | null;
  feeds: FeedsSnapshot;
  darwinWeights: DarwinWeightEntry[];
  recentRuns: PipelineRunSummary[];
  lastRunId: string | null;

  // Actions
  updateFromSnapshot: (snapshot: Record<string, unknown>) => void;
  setRecentRuns: (runs: PipelineRunSummary[]) => void;
  setDarwinWeights: (weights: DarwinWeightEntry[]) => void;
}

export const usePipelineStore = create<PipelineState>((set) => ({
  regime: null,
  feeds: {},
  darwinWeights: [],
  recentRuns: [],
  lastRunId: null,

  updateFromSnapshot: (snapshot) => {
    set({
      regime: (snapshot.regime as RegimeSignal) ?? null,
      feeds: (snapshot.feeds as FeedsSnapshot) ?? {},
      darwinWeights: Array.isArray(snapshot.darwinWeights)
        ? (snapshot.darwinWeights as DarwinWeightEntry[])
        : [],
      lastRunId: (snapshot.lastPipelineRun as { id?: string })?.id ?? null,
    });
  },

  setRecentRuns: (runs) => set({ recentRuns: runs }),
  setDarwinWeights: (weights) => set({ darwinWeights: weights }),
}));
