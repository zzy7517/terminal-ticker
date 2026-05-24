/**
 * core/usage.ts — Pure helpers for assembling Usage / UsageCost values.
 *
 * Providers call computeUsage() at the end of a stream to convert raw token
 * counts into the standardized Usage shape that AssistantMessage carries.
 */

import type { ModelCostRates, Usage, UsageCost } from "./types.js";

/** Compute USD cost from token counts and per-million-token rates. */
export function computeUsageCost(
  input: number,
  output: number,
  cacheRead: number,
  cacheWrite: number,
  rates?: ModelCostRates,
): UsageCost {
  if (!rates) {
    return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
  }
  const inputCost = (input / 1_000_000) * rates.input;
  const outputCost = (output / 1_000_000) * rates.output;
  const cacheReadCost = (cacheRead / 1_000_000) * rates.cacheRead;
  const cacheWriteCost = (cacheWrite / 1_000_000) * rates.cacheWrite;
  return {
    input: inputCost,
    output: outputCost,
    cacheRead: cacheReadCost,
    cacheWrite: cacheWriteCost,
    total: inputCost + outputCost + cacheReadCost + cacheWriteCost,
  };
}

/** Bundle token counts + rates into a Usage object. */
export function computeUsage(input: {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  rates?: ModelCostRates;
}): Usage {
  const cacheRead = input.cacheReadTokens ?? 0;
  const cacheWrite = input.cacheWriteTokens ?? 0;
  const totalTokens = input.inputTokens + input.outputTokens;
  return {
    input: input.inputTokens,
    output: input.outputTokens,
    cacheRead,
    cacheWrite,
    totalTokens,
    cost: computeUsageCost(input.inputTokens, input.outputTokens, cacheRead, cacheWrite, input.rates),
  };
}
