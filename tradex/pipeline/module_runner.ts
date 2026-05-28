/**
 * ModuleRunner — executes a single analysis module via LLM.
 *
 * Reuses the existing agent infrastructure (LLM client) but with
 * short focused prompts and JSON-only output.
 */

import type { ModuleOutput, ModuleRunResult, RegimeSignal } from "./types.js";
import type { PromptComposer } from "./prompt_composer.js";

export interface LLMCallFn {
  (systemPrompt: string, userPrompt: string): Promise<{ content: string; tokensUsed: number }>;
}

export interface ModuleRunnerDeps {
  promptComposer: PromptComposer;
  llmCall: LLMCallFn;
}

export class ModuleRunner {
  private deps: ModuleRunnerDeps;

  constructor(deps: ModuleRunnerDeps) {
    this.deps = deps;
  }

  async run(
    moduleId: string,
    instrumentKey: string,
    regime: RegimeSignal,
    candleData: string,
    darwinWeight: number,
    additionalContext?: string,
  ): Promise<ModuleRunResult> {
    const start = Date.now();

    try {
      const { systemPrompt, userPrompt } = this.deps.promptComposer.compose({
        moduleId,
        instrumentKey,
        regime,
        candleData,
        additionalContext,
      });

      const { content, tokensUsed } = await this.deps.llmCall(systemPrompt, userPrompt);
      const output = this.parseOutput(moduleId, content);

      return {
        moduleId,
        darwinWeight,
        output,
        tokensUsed,
        durationMs: Date.now() - start,
        error: null,
      };
    } catch (e) {
      return {
        moduleId,
        darwinWeight,
        output: this.neutralOutput(moduleId),
        tokensUsed: 0,
        durationMs: Date.now() - start,
        error: String(e),
      };
    }
  }

  private parseOutput(moduleId: string, raw: string): ModuleOutput {
    // Try to extract JSON from response (might be wrapped in ```json blocks)
    let jsonStr = raw.trim();
    if (jsonStr.startsWith("```")) {
      const match = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (match) jsonStr = match[1].trim();
    }

    try {
      const parsed = JSON.parse(jsonStr);
      return {
        moduleId,
        signal: this.validateSignal(parsed.signal),
        conviction: Math.max(0, Math.min(100, Number(parsed.conviction) || 0)),
        entry: parsed.entry ?? null,
        stopLoss: parsed.stop_loss ?? parsed.stopLoss ?? null,
        takeProfit: parsed.take_profit ?? parsed.takeProfit ?? null,
        keyLevels: {
          support: Array.isArray(parsed.key_levels?.support) ? parsed.key_levels.support : [],
          resistance: Array.isArray(parsed.key_levels?.resistance) ? parsed.key_levels.resistance : [],
        },
        reasoning: String(parsed.reasoning ?? "").slice(0, 500),
      };
    } catch {
      // If JSON parsing fails, return neutral
      return this.neutralOutput(moduleId);
    }
  }

  private validateSignal(raw: unknown): "LONG" | "SHORT" | "NEUTRAL" {
    const s = String(raw).toUpperCase();
    if (s === "LONG" || s === "SHORT") return s;
    return "NEUTRAL";
  }

  private neutralOutput(moduleId: string): ModuleOutput {
    return {
      moduleId,
      signal: "NEUTRAL",
      conviction: 0,
      entry: null,
      stopLoss: null,
      takeProfit: null,
      keyLevels: { support: [], resistance: [] },
      reasoning: "Module failed to produce output",
    };
  }
}
