/**
 * core/models-metadata.ts — Pre-defined model metadata for common models.
 *
 * Provides contextWindow, maxTokens, and cost rates so context-usage
 * calculations don't need fallback guessing.
 *
 * Costs are in dollars per million tokens (as of May 2025 pricing).
 */

import type { ModelCostRates } from "./types.js";

export interface ModelMetadata {
  contextWindow: number;
  maxTokens: number;
  cost: ModelCostRates;
  inputs: ("text" | "image")[];
}

/**
 * Model metadata registry keyed by model ID.
 * Partial matches are supported via `lookupModelMetadata()`.
 */
const MODEL_METADATA: Record<string, ModelMetadata> = {
  // =========================================================================
  // Anthropic Claude
  // =========================================================================

  // Claude 4 family
  "claude-opus-4-20250514": {
    contextWindow: 200_000,
    maxTokens: 32_000,
    cost: { input: 15.0, output: 75.0, cacheRead: 1.5, cacheWrite: 18.75 },
    inputs: ["text", "image"],
  },
  "claude-sonnet-4-20250514": {
    contextWindow: 200_000,
    maxTokens: 16_000,
    cost: { input: 3.0, output: 15.0, cacheRead: 0.3, cacheWrite: 3.75 },
    inputs: ["text", "image"],
  },

  // Claude 3.7 Sonnet
  "claude-3-7-sonnet-20250219": {
    contextWindow: 200_000,
    maxTokens: 16_000,
    cost: { input: 3.0, output: 15.0, cacheRead: 0.3, cacheWrite: 3.75 },
    inputs: ["text", "image"],
  },

  // Claude 3.5 family
  "claude-3-5-sonnet-20241022": {
    contextWindow: 200_000,
    maxTokens: 8_192,
    cost: { input: 3.0, output: 15.0, cacheRead: 0.3, cacheWrite: 3.75 },
    inputs: ["text", "image"],
  },
  "claude-3-5-haiku-20241022": {
    contextWindow: 200_000,
    maxTokens: 8_192,
    cost: { input: 0.8, output: 4.0, cacheRead: 0.08, cacheWrite: 1.0 },
    inputs: ["text", "image"],
  },

  // Claude 3 family
  "claude-3-opus-20240229": {
    contextWindow: 200_000,
    maxTokens: 4_096,
    cost: { input: 15.0, output: 75.0, cacheRead: 1.5, cacheWrite: 18.75 },
    inputs: ["text", "image"],
  },
  "claude-3-sonnet-20240229": {
    contextWindow: 200_000,
    maxTokens: 4_096,
    cost: { input: 3.0, output: 15.0, cacheRead: 0.3, cacheWrite: 3.75 },
    inputs: ["text", "image"],
  },
  "claude-3-haiku-20240307": {
    contextWindow: 200_000,
    maxTokens: 4_096,
    cost: { input: 0.25, output: 1.25, cacheRead: 0.03, cacheWrite: 0.3 },
    inputs: ["text", "image"],
  },

  // =========================================================================
  // OpenAI / Codex — GPT-4o family
  // =========================================================================
  "gpt-4o": {
    contextWindow: 128_000,
    maxTokens: 16_384,
    cost: { input: 2.5, output: 10.0, cacheRead: 1.25, cacheWrite: 0 },
    inputs: ["text", "image"],
  },
  "gpt-4o-2024-11-20": {
    contextWindow: 128_000,
    maxTokens: 16_384,
    cost: { input: 2.5, output: 10.0, cacheRead: 1.25, cacheWrite: 0 },
    inputs: ["text", "image"],
  },
  "gpt-4o-mini": {
    contextWindow: 128_000,
    maxTokens: 16_384,
    cost: { input: 0.15, output: 0.6, cacheRead: 0.075, cacheWrite: 0 },
    inputs: ["text", "image"],
  },

  // =========================================================================
  // OpenAI / Codex — GPT-4.1 family
  // =========================================================================
  "gpt-4.1": {
    contextWindow: 1_048_576,
    maxTokens: 32_768,
    cost: { input: 2.0, output: 8.0, cacheRead: 0.5, cacheWrite: 0 },
    inputs: ["text", "image"],
  },
  "gpt-4.1-mini": {
    contextWindow: 1_048_576,
    maxTokens: 32_768,
    cost: { input: 0.4, output: 1.6, cacheRead: 0.1, cacheWrite: 0 },
    inputs: ["text", "image"],
  },
  "gpt-4.1-nano": {
    contextWindow: 1_048_576,
    maxTokens: 32_768,
    cost: { input: 0.1, output: 0.4, cacheRead: 0.025, cacheWrite: 0 },
    inputs: ["text", "image"],
  },

  // =========================================================================
  // OpenAI / Codex — o-series reasoning models
  // =========================================================================
  "o1": {
    contextWindow: 200_000,
    maxTokens: 100_000,
    cost: { input: 15.0, output: 60.0, cacheRead: 7.5, cacheWrite: 0 },
    inputs: ["text", "image"],
  },
  "o1-mini": {
    contextWindow: 128_000,
    maxTokens: 65_536,
    cost: { input: 1.1, output: 4.4, cacheRead: 0.55, cacheWrite: 0 },
    inputs: ["text"],
  },
  "o3": {
    contextWindow: 200_000,
    maxTokens: 100_000,
    cost: { input: 2.0, output: 8.0, cacheRead: 0.5, cacheWrite: 0 },
    inputs: ["text", "image"],
  },
  "o3-mini": {
    contextWindow: 200_000,
    maxTokens: 100_000,
    cost: { input: 1.1, output: 4.4, cacheRead: 0.55, cacheWrite: 0 },
    inputs: ["text"],
  },
  "o4-mini": {
    contextWindow: 200_000,
    maxTokens: 100_000,
    cost: { input: 1.1, output: 4.4, cacheRead: 0.55, cacheWrite: 0 },
    inputs: ["text"],
  },

  // =========================================================================
  // OpenAI / Codex — GPT-5 family
  // =========================================================================
  "gpt-5": {
    contextWindow: 1_048_576,
    maxTokens: 32_768,
    cost: { input: 5.0, output: 20.0, cacheRead: 1.25, cacheWrite: 0 },
    inputs: ["text", "image"],
  },
  "codex-mini-latest": {
    contextWindow: 200_000,
    maxTokens: 100_000,
    cost: { input: 1.5, output: 6.0, cacheRead: 0.375, cacheWrite: 0 },
    inputs: ["text", "image"],
  },
};

// Aliases — point common short names to their canonical entries
const MODEL_ALIASES: Record<string, string> = {
  "claude-opus-4": "claude-opus-4-20250514",
  "claude-sonnet-4": "claude-sonnet-4-20250514",
  "claude-3.7-sonnet": "claude-3-7-sonnet-20250219",
  "claude-3-7-sonnet": "claude-3-7-sonnet-20250219",
  "claude-3.5-sonnet": "claude-3-5-sonnet-20241022",
  "claude-3-5-sonnet": "claude-3-5-sonnet-20241022",
  "claude-3.5-haiku": "claude-3-5-haiku-20241022",
  "claude-3-5-haiku": "claude-3-5-haiku-20241022",
  "claude-3-opus": "claude-3-opus-20240229",
  "claude-3-sonnet": "claude-3-sonnet-20240229",
  "claude-3-haiku": "claude-3-haiku-20240307",
  "gpt-4o-2024-08-06": "gpt-4o",
  "o1-preview": "o1",
};

/**
 * Look up model metadata by ID.
 *
 * Resolution order:
 * 1. Exact match in MODEL_METADATA
 * 2. Exact match via MODEL_ALIASES
 * 3. Prefix match (e.g. "claude-sonnet-4-v1" matches "claude-sonnet-4-20250514" via alias)
 * 4. undefined (caller should use fallback defaults)
 */
export function lookupModelMetadata(modelId: string): ModelMetadata | undefined {
  // Exact match
  if (MODEL_METADATA[modelId]) return MODEL_METADATA[modelId];

  // Alias match
  const aliasTarget = MODEL_ALIASES[modelId];
  if (aliasTarget && MODEL_METADATA[aliasTarget]) return MODEL_METADATA[aliasTarget];

  // Prefix match: find the longest key that the modelId starts with
  const lower = modelId.toLowerCase();
  let bestMatch: ModelMetadata | undefined;
  let bestLen = 0;

  for (const key of Object.keys(MODEL_METADATA)) {
    if (lower.startsWith(key.toLowerCase()) && key.length > bestLen) {
      bestMatch = MODEL_METADATA[key];
      bestLen = key.length;
    }
  }

  if (bestMatch) return bestMatch;

  // Try aliases as prefixes
  for (const [alias, target] of Object.entries(MODEL_ALIASES)) {
    if (lower.startsWith(alias.toLowerCase()) && alias.length > bestLen) {
      bestMatch = MODEL_METADATA[target];
      bestLen = alias.length;
    }
  }

  return bestMatch;
}

/**
 * Get the context window for a model, with a conservative fallback.
 * Used by context-usage calculations.
 */
export function getContextWindow(modelId: string): number {
  const meta = lookupModelMetadata(modelId);
  return meta?.contextWindow ?? 128_000; // Conservative fallback
}

/**
 * Get the max output tokens for a model, with a fallback.
 */
export function getMaxTokens(modelId: string): number {
  const meta = lookupModelMetadata(modelId);
  return meta?.maxTokens ?? 8_192; // Conservative fallback
}
