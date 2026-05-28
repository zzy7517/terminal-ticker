/**
 * Pipeline Orchestrator — runs the full 4-layer analysis pipeline.
 *
 * Layer 1: Regime Detection (pure data, no LLM)
 * Layer 2: Multi-method Analysis (parallel LLM)
 * Layer 3: Synthesis + CRO (sequential LLM)
 * Layer 4: Execution decision
 */

import { randomUUID } from "crypto";
import type { PipelineRun, PipelineTrigger, TradeDecision, ModuleRunResult, RegimeSignal } from "./types.js";
import type { RegimeDetector } from "./regime_detector.js";
import type { PromptComposer } from "./prompt_composer.js";
import { ModuleRunner, type LLMCallFn } from "./module_runner.js";
import { Synthesizer } from "./synthesizer.js";
import { AdversarialReviewer } from "./adversarial.js";
import type { DarwinWeightEntry } from "../evolution/types.js";

export interface OrchestratorDeps {
  regimeDetector: RegimeDetector;
  promptComposer: PromptComposer;
  llmCall: LLMCallFn;
  /** Get formatted candle data for the instrument. */
  getCandleData: (instrumentKey: string) => string;
  /** Get current price for the instrument. */
  getCurrentPrice: (instrumentKey: string) => number | null;
  /** Get darwin weights for all modules. */
  getDarwinWeights: () => DarwinWeightEntry[];
  /** Get additional context for fundamental module (funding, OI, etc.). */
  getFundamentalContext: (instrumentKey: string) => string;
  /** Get funding rate for CRO. */
  getFundingRate: (instrumentKey: string) => number | null;
  /** Get long/short ratio for CRO. */
  getLongShortRatio: (instrumentKey: string) => number | null;
  /** Get OI delta for CRO. */
  getOIDelta: (instrumentKey: string) => number | null;
  /** Callback when pipeline completes (for persistence/events). */
  onComplete?: (run: PipelineRun) => void;
}

const ANALYSIS_MODULES = [
  "ict_trader",
  "chanlun_analyst",
  "wave_analyst",
  "indicator_analyst",
  "fundamental_analyst",
] as const;

export class PipelineOrchestrator {
  private deps: OrchestratorDeps;
  private moduleRunner: ModuleRunner;
  private synthesizer: Synthesizer;
  private croReviewer: AdversarialReviewer;
  private running = false;

  /** Most recent regime (for WebSocket snapshot). */
  currentRegime: RegimeSignal | null = null;
  /** Most recent run summary. */
  lastRun: PipelineRun | null = null;

  constructor(deps: OrchestratorDeps) {
    this.deps = deps;
    this.moduleRunner = new ModuleRunner({
      promptComposer: deps.promptComposer,
      llmCall: deps.llmCall,
    });
    this.synthesizer = new Synthesizer();
    this.croReviewer = new AdversarialReviewer(deps.promptComposer, deps.llmCall);
  }

  get isRunning(): boolean {
    return this.running;
  }

  async run(instrumentKey: string, trigger: PipelineTrigger): Promise<PipelineRun> {
    if (this.running) {
      throw new Error("Pipeline already running");
    }
    this.running = true;
    const id = randomUUID();
    const startedAt = new Date().toISOString();

    try {
      // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
      // LAYER 1: Regime Detection
      // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
      const regime = this.deps.regimeDetector.detect(instrumentKey);
      this.currentRegime = regime;

      // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
      // LAYER 2: Multi-method Analysis (parallel)
      // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
      const candleData = this.deps.getCandleData(instrumentKey);
      const weights = this.deps.getDarwinWeights();
      const weightMap = new Map(weights.map((w) => [w.moduleId, w.weight]));

      const modulePromises = ANALYSIS_MODULES.map((moduleId) => {
        const weight = weightMap.get(moduleId) ?? 1.0;
        const additionalContext = moduleId === "fundamental_analyst"
          ? this.deps.getFundamentalContext(instrumentKey)
          : undefined;
        return this.moduleRunner.run(moduleId, instrumentKey, regime, candleData, weight, additionalContext);
      });

      const moduleResults: ModuleRunResult[] = await Promise.all(modulePromises);

      // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
      // LAYER 3: Synthesis + CRO
      // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
      const currentPrice = this.deps.getCurrentPrice(instrumentKey);

      const synthesis = this.synthesizer.synthesize({
        regime,
        moduleResults,
        instrumentKey,
        currentPrice: currentPrice ?? 0,
      });

      let decision: TradeDecision;

      // Short-circuit: if consensus too low, PASS without CRO
      if (synthesis.modulesAgreeing < 3 || synthesis.aggregatedSignal === "NEUTRAL") {
        decision = {
          action: "PASS",
          instrumentKey,
          entry: null,
          stopLoss: null,
          takeProfit: null,
          positionSizePct: null,
          riskRewardRatio: null,
          confidence: synthesis.weightedConviction,
          modulesAgreeing: synthesis.modulesAgreeing,
          modulesTotal: synthesis.modulesTotal,
          survivedCRO: false,
          croObjections: [],
          reflexivityFlags: [],
          reasoning: `共振不足 (${synthesis.modulesAgreeing}/${synthesis.modulesTotal})，观望`,
        };
      } else {
        // Run CRO
        const croResult = await this.croReviewer.review({
          synthesis,
          regime,
          instrumentKey,
          currentPrice: currentPrice ?? 0,
          fundingRate: this.deps.getFundingRate(instrumentKey),
          longShortRatio: this.deps.getLongShortRatio(instrumentKey),
          oiDelta: this.deps.getOIDelta(instrumentKey),
        });

        if (!croResult.approved) {
          decision = {
            action: "PASS",
            instrumentKey,
            entry: synthesis.consensusEntry,
            stopLoss: synthesis.consensusSL,
            takeProfit: synthesis.consensusTP,
            positionSizePct: null,
            riskRewardRatio: null,
            confidence: croResult.adjustedConviction,
            modulesAgreeing: synthesis.modulesAgreeing,
            modulesTotal: synthesis.modulesTotal,
            survivedCRO: false,
            croObjections: croResult.objections,
            reflexivityFlags: croResult.reflexivityFlags,
            reasoning: `CRO rejected: ${croResult.reasoning}`,
          };
        } else {
          // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
          // LAYER 4: Build final decision
          // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
          const action = synthesis.aggregatedSignal === "LONG" ? "OPEN_LONG" : "OPEN_SHORT";
          const rr = this.calcRR(synthesis.consensusEntry, synthesis.consensusSL, synthesis.consensusTP, action);

          decision = {
            action,
            instrumentKey,
            entry: synthesis.consensusEntry,
            stopLoss: synthesis.consensusSL,
            takeProfit: synthesis.consensusTP,
            positionSizePct: this.calcPositionSize(synthesis.modulesAgreeing, synthesis.modulesTotal),
            riskRewardRatio: rr,
            confidence: croResult.adjustedConviction,
            modulesAgreeing: synthesis.modulesAgreeing,
            modulesTotal: synthesis.modulesTotal,
            survivedCRO: true,
            croObjections: croResult.objections,
            reflexivityFlags: croResult.reflexivityFlags,
            reasoning: synthesis.reasoning,
          };

          // Final R:R gate
          if (rr !== null && rr < 1.5) {
            decision.action = "PASS";
            decision.reasoning = `R:R ${rr.toFixed(1)} < 1.5, 不满足最低风报比`;
          }
        }
      }

      const totalTokens = moduleResults.reduce((s, r) => s + r.tokensUsed, 0);
      const run: PipelineRun = {
        id,
        triggeredBy: trigger,
        instrumentKey,
        regime,
        startedAt,
        completedAt: new Date().toISOString(),
        status: "completed",
        moduleResults,
        decision,
        totalTokens,
        totalCostUsd: totalTokens * 0.000003, // rough estimate
        durationMs: Date.now() - new Date(startedAt).getTime(),
      };

      this.lastRun = run;
      this.deps.onComplete?.(run);
      return run;
    } catch (e) {
      const run: PipelineRun = {
        id,
        triggeredBy: trigger,
        instrumentKey,
        regime: this.currentRegime ?? { market: "NEUTRAL", volatility: "MEDIUM", trend: "RANGE", indicators: { vix: null, adx: null, fearGreed: null, fundingRate: null, longShortRatio: null, oiDelta1h: null, dxy: null }, detectedAt: startedAt },
        startedAt,
        completedAt: new Date().toISOString(),
        status: "failed",
        moduleResults: [],
        decision: null,
        totalTokens: 0,
        totalCostUsd: 0,
        durationMs: Date.now() - new Date(startedAt).getTime(),
      };
      this.lastRun = run;
      throw e;
    } finally {
      this.running = false;
    }
  }

  private calcRR(entry: number | null, sl: number | null, tp: number | null, action: string): number | null {
    if (!entry || !sl || !tp) return null;
    const risk = Math.abs(entry - sl);
    const reward = Math.abs(tp - entry);
    if (risk === 0) return null;
    return Math.round((reward / risk) * 10) / 10;
  }

  private calcPositionSize(agreeing: number, total: number): number {
    // High consensus = 2% risk, medium = 1%
    if (agreeing >= 4) return 2.0;
    if (agreeing >= 3) return 1.0;
    return 0.5;
  }
}
