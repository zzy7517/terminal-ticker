/**
 * Evolution system types — scorecard, darwin weights, recommendations.
 */

export interface ModuleScore {
  moduleId: string;
  darwinWeight: number;       // 0.3 - 2.5
  sharpe30d: number;
  hitRate30d: number;         // 0-1
  totalRecommendations: number;
  modificationsAttempted: number;
  modificationsKept: number;
  lastModifiedAt: string | null;
  updatedAt: string;
}

export interface Recommendation {
  id?: number;
  moduleId: string;
  instrumentKey: string;
  signal: "LONG" | "SHORT" | "NEUTRAL";
  conviction: number;
  priceAtRecommendation: number;
  recommendedAt: string;
  // Forward returns — filled in later by tracking cron
  return1d: number | null;
  return5d: number | null;
  return20d: number | null;
}

export interface DarwinWeightEntry {
  moduleId: string;
  weight: number;
  sharpe30d: number | null;
  hitRate30d: number | null;
  updatedAt: string;
}

export interface PromptModification {
  id?: number;
  moduleId: string;
  gitBranch: string;
  description: string;
  beforeSharpe: number;
  afterSharpe: number | null;
  status: "testing" | "kept" | "reverted";
  createdAt: string;
  evaluatedAt: string | null;
}

/** Default starting weights for all modules. */
export const DEFAULT_MODULE_IDS = [
  "ict_trader",
  "chanlun_analyst",
  "wave_analyst",
  "indicator_analyst",
  "fundamental_analyst",
] as const;

export type ModuleId = (typeof DEFAULT_MODULE_IDS)[number];

export const DEFAULT_DARWIN_WEIGHT = 1.0;
export const MIN_DARWIN_WEIGHT = 0.3;
export const MAX_DARWIN_WEIGHT = 2.5;
export const WEIGHT_GROWTH_FACTOR = 1.05;
export const WEIGHT_DECAY_FACTOR = 0.95;
