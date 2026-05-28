/**
 * Synthesizer — aggregates module outputs into a consensus signal.
 *
 * Pure logic, no LLM call needed (weighted voting).
 */

import type { ModuleRunResult, SynthesisInput, SynthesisOutput, SignalDirection } from "./types.js";

export class Synthesizer {
  /** Aggregate module results into synthesis output. */
  synthesize(input: SynthesisInput): SynthesisOutput {
    const { moduleResults, regime } = input;
    const validResults = moduleResults.filter((r) => r.error === null);

    if (validResults.length === 0) {
      return this.neutralOutput(moduleResults.length);
    }

    // Weighted voting
    const votes = { LONG: 0, SHORT: 0, NEUTRAL: 0 };
    let totalWeight = 0;
    let weightedConviction = 0;

    for (const r of validResults) {
      const w = r.darwinWeight;
      votes[r.output.signal] += w;
      totalWeight += w;
      if (r.output.signal !== "NEUTRAL") {
        weightedConviction += r.output.conviction * w;
      }
    }

    // Determine dominant signal
    const aggregatedSignal = this.dominantSignal(votes);

    // Count modules agreeing with dominant signal
    const agreeing = validResults.filter((r) => r.output.signal === aggregatedSignal);
    const modulesAgreeing = agreeing.length;

    // Weighted conviction (normalized by weight of agreeing modules)
    const agreeingWeight = agreeing.reduce((s, r) => s + r.darwinWeight, 0);
    const normalizedConviction = agreeingWeight > 0
      ? weightedConviction / agreeingWeight
      : 0;

    // Apply regime modifier
    const regimeModifier = this.regimeConvictionModifier(regime.volatility);
    const finalConviction = Math.round(normalizedConviction * regimeModifier);

    // Consensus levels (median of agreeing modules)
    const entries = agreeing.map((r) => r.output.entry).filter((v): v is number => v !== null);
    const sls = agreeing.map((r) => r.output.stopLoss).filter((v): v is number => v !== null);
    const tps = agreeing.map((r) => r.output.takeProfit).filter((v): v is number => v !== null);

    return {
      aggregatedSignal,
      weightedConviction: finalConviction,
      modulesAgreeing,
      modulesTotal: validResults.length,
      consensusEntry: this.median(entries),
      consensusSL: this.median(sls),
      consensusTP: this.median(tps),
      reasoning: this.buildReasoning(validResults, aggregatedSignal, modulesAgreeing),
    };
  }

  private dominantSignal(votes: Record<string, number>): SignalDirection {
    if (votes.LONG > votes.SHORT && votes.LONG > votes.NEUTRAL) return "LONG";
    if (votes.SHORT > votes.LONG && votes.SHORT > votes.NEUTRAL) return "SHORT";
    return "NEUTRAL";
  }

  private regimeConvictionModifier(volatility: string): number {
    switch (volatility) {
      case "EXTREME": return 0.6;
      case "HIGH": return 0.8;
      case "MEDIUM": return 1.0;
      case "LOW": return 1.0;
      default: return 1.0;
    }
  }

  private median(values: number[]): number | null {
    if (values.length === 0) return null;
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  }

  private buildReasoning(results: ModuleRunResult[], signal: SignalDirection, agreeing: number): string {
    const summaries = results
      .filter((r) => r.output.signal === signal)
      .map((r) => `${r.moduleId}(w=${r.darwinWeight.toFixed(1)}): ${r.output.reasoning.slice(0, 80)}`)
      .join("; ");
    return `${agreeing}/${results.length}模块共振${signal}。${summaries}`;
  }

  private neutralOutput(total: number): SynthesisOutput {
    return {
      aggregatedSignal: "NEUTRAL",
      weightedConviction: 0,
      modulesAgreeing: 0,
      modulesTotal: total,
      consensusEntry: null,
      consensusSL: null,
      consensusTP: null,
      reasoning: "No valid module outputs",
    };
  }
}
