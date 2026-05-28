/**
 * Pipeline & Evolution state — derived from WebSocket snapshot + REST.
 */

import { create } from "zustand";
import type { RegimeSignal, PipelineRunSummary, DarwinWeightEntry } from "../types";

interface FeedsSnapshot {
  fear_greed?: { value: number; classification: string; timestamp: string } | null;
  funding?: { instrumentKey: string; rate: number; timestamp: string } | null;
  long_short_ratio?: { instrumentKey: string; ratio: number; longPct: number; shortPct: number } | null;
  oi_delta?: { instrumentKey: string; oi: number; delta1h: number; timestamp: string } | null;
  dxy?: { value: number; eurusd: number; timestamp: string } | null;
}

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
