/**
 * Adversarial CRO review — the last gate before execution.
 *
 * Uses the risk_officer prompt via LLM to challenge the trade candidate.
 */

import type { CROInput, CROOutput } from "./types.js";
import type { PromptComposer } from "./prompt_composer.js";
import type { LLMCallFn } from "./module_runner.js";

export class AdversarialReviewer {
  private promptComposer: PromptComposer;
  private llmCall: LLMCallFn;

  constructor(promptComposer: PromptComposer, llmCall: LLMCallFn) {
    this.promptComposer = promptComposer;
    this.llmCall = llmCall;
  }

  async review(input: CROInput): Promise<CROOutput> {
    const candidateJson = JSON.stringify({
      signal: input.synthesis.aggregatedSignal,
      conviction: input.synthesis.weightedConviction,
      entry: input.synthesis.consensusEntry,
      stop_loss: input.synthesis.consensusSL,
      take_profit: input.synthesis.consensusTP,
      modules_agreeing: input.synthesis.modulesAgreeing,
      modules_total: input.synthesis.modulesTotal,
      reasoning: input.synthesis.reasoning,
    }, null, 2);

    const contextLines: string[] = [
      `Instrument: ${input.instrumentKey}`,
      `Current Price: ${input.currentPrice}`,
      `Regime: ${input.regime.market} / Vol:${input.regime.volatility} / Trend:${input.regime.trend}`,
    ];
    if (input.fundingRate !== null) contextLines.push(`Funding Rate: ${(input.fundingRate * 100).toFixed(4)}%`);
    if (input.longShortRatio !== null) contextLines.push(`Long/Short Ratio: ${input.longShortRatio.toFixed(2)}`);
    if (input.oiDelta !== null) contextLines.push(`OI Delta 1h: $${Math.round(input.oiDelta).toLocaleString()}`);

    const { systemPrompt, userPrompt } = this.promptComposer.composeCRO(
      candidateJson,
      contextLines.join("\n"),
    );

    try {
      const { content } = await this.llmCall(systemPrompt, userPrompt);
      return this.parseOutput(content);
    } catch {
      // If CRO fails, default to reject (fail safe)
      return {
        approved: false,
        objections: ["CRO review failed — defaulting to reject"],
        reflexivityFlags: [],
        riskLevel: "HIGH",
        adjustedConviction: 0,
        reasoning: "CRO module error",
      };
    }
  }

  private parseOutput(raw: string): CROOutput {
    let jsonStr = raw.trim();
    if (jsonStr.startsWith("```")) {
      const match = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (match) jsonStr = match[1].trim();
    }

    try {
      const parsed = JSON.parse(jsonStr);
      return {
        approved: Boolean(parsed.approved),
        objections: Array.isArray(parsed.objections) ? parsed.objections.map(String) : [],
        reflexivityFlags: Array.isArray(parsed.reflexivity_flags) ? parsed.reflexivity_flags.map(String) : [],
        riskLevel: this.validateRiskLevel(parsed.risk_level),
        adjustedConviction: Math.max(0, Math.min(100, Number(parsed.adjusted_conviction) || 0)),
        reasoning: String(parsed.reasoning ?? "").slice(0, 500),
      };
    } catch {
      return {
        approved: false,
        objections: ["Failed to parse CRO output"],
        reflexivityFlags: [],
        riskLevel: "HIGH",
        adjustedConviction: 0,
        reasoning: "Parse error",
      };
    }
  }

  private validateRiskLevel(raw: unknown): "LOW" | "MEDIUM" | "HIGH" | "EXTREME" {
    const s = String(raw).toUpperCase();
    if (s === "LOW" || s === "MEDIUM" || s === "HIGH" || s === "EXTREME") return s;
    return "MEDIUM";
  }
}
