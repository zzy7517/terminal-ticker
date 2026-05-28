/**
 * Pipeline types — shared across orchestrator, modules, and API.
 */

// ============================================================================
// Regime
// ============================================================================

export type MarketRegime = "RISK_ON" | "RISK_OFF" | "NEUTRAL";
export type VolatilityRegime = "LOW" | "MEDIUM" | "HIGH" | "EXTREME";
export type TrendRegime = "STRONG_UP" | "UP" | "RANGE" | "DOWN" | "STRONG_DOWN";

export interface RegimeSignal {
  market: MarketRegime;
  volatility: VolatilityRegime;
  trend: TrendRegime;
  indicators: RegimeIndicators;
  detectedAt: string;
}

export interface RegimeIndicators {
  vix: number | null;
  adx: number | null;
  fearGreed: number | null;
  fundingRate: number | null;
  longShortRatio: number | null;
  oiDelta1h: number | null;
  dxy: number | null;
}

// ============================================================================
// Module Output
// ============================================================================

export type SignalDirection = "LONG" | "SHORT" | "NEUTRAL";

export interface ModuleOutput {
  moduleId: string;
  signal: SignalDirection;
  conviction: number;       // 0-100
  entry: number | null;
  stopLoss: number | null;
  takeProfit: number | null;
  keyLevels: {
    support: number[];
    resistance: number[];
  };
  reasoning: string;        // concise, ~200 chars
}

export interface ModuleRunResult {
  moduleId: string;
  darwinWeight: number;
  output: ModuleOutput;
  tokensUsed: number;
  durationMs: number;
  error: string | null;
}

// ============================================================================
// Pipeline Run
// ============================================================================

export type PipelineTrigger = "cron" | "manual" | "signal";
export type PipelineStatus = "running" | "completed" | "failed";
export type TradeAction = "OPEN_LONG" | "OPEN_SHORT" | "CLOSE" | "HOLD" | "PASS";

export interface TradeDecision {
  action: TradeAction;
  instrumentKey: string;
  entry: number | null;
  stopLoss: number | null;
  takeProfit: number | null;
  positionSizePct: number | null;
  riskRewardRatio: number | null;
  confidence: number;          // 0-100
  modulesAgreeing: number;
  modulesTotal: number;
  survivedCRO: boolean;
  croObjections: string[];
  reflexivityFlags: string[];
  reasoning: string;
}

export interface PipelineRun {
  id: string;
  triggeredBy: PipelineTrigger;
  instrumentKey: string;
  regime: RegimeSignal;
  startedAt: string;
  completedAt: string | null;
  status: PipelineStatus;
  moduleResults: ModuleRunResult[];
  decision: TradeDecision | null;
  totalTokens: number;
  totalCostUsd: number;
  durationMs: number;
}

// ============================================================================
// Synthesis
// ============================================================================

export interface SynthesisInput {
  regime: RegimeSignal;
  moduleResults: ModuleRunResult[];
  instrumentKey: string;
  currentPrice: number;
}

export interface SynthesisOutput {
  aggregatedSignal: SignalDirection;
  weightedConviction: number;
  modulesAgreeing: number;
  modulesTotal: number;
  consensusEntry: number | null;
  consensusSL: number | null;
  consensusTP: number | null;
  reasoning: string;
}

// ============================================================================
// CRO (Adversarial Review)
// ============================================================================

export interface CROInput {
  synthesis: SynthesisOutput;
  regime: RegimeSignal;
  instrumentKey: string;
  currentPrice: number;
  fundingRate: number | null;
  longShortRatio: number | null;
  oiDelta: number | null;
}

export interface CROOutput {
  approved: boolean;
  objections: string[];
  reflexivityFlags: string[];
  riskLevel: "LOW" | "MEDIUM" | "HIGH" | "EXTREME";
  adjustedConviction: number; // CRO may reduce conviction
  reasoning: string;
}
