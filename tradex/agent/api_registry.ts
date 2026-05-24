/**
 * api_registry.ts — Global API provider registry.
 *
 * Maps API wire-format strings (e.g. "codex_responses", "anthropic_messages")
 * to stateless stream functions. This is the central dispatch layer that
 * makes model switching a pointer swap rather than a provider rebuild.
 *
 * Modeled after pi-mono's api-registry.ts but adapted for this project's
 * simpler ChatResponse-based interface.
 */

import type { AgentModel } from "./models.js";
import type { ChatResponse } from "./llm_client.js";

/**
 * The input shape passed to a registered stream function.
 */
export interface ChatInput {
  messages: Array<Record<string, unknown>>;
  tools?: Array<Record<string, unknown>> | null;
  onDelta?: ((delta: string) => void | Promise<void>) | null;
  signal?: AbortSignal;
}

/**
 * A stateless stream function that takes a model descriptor and chat input,
 * and returns a ChatResponse. No internal state, no connection lifecycle.
 */
export type ApiStreamFunction = (model: AgentModel, input: ChatInput) => Promise<ChatResponse>;

/**
 * A model lister function that returns available models for a provider.
 */
export type ApiListModelsFunction = (model: AgentModel) => Promise<Array<Record<string, unknown>>>;

interface RegisteredProvider {
  api: string;
  stream: ApiStreamFunction;
  listModels: ApiListModelsFunction;
}

// ---- Global registry singleton ----

const registry = new Map<string, RegisteredProvider>();

/**
 * Register a provider's stream function under an API key.
 * Overwrites any previous registration for the same API.
 */
export function registerApiProvider(entry: {
  api: string;
  stream: ApiStreamFunction;
  listModels: ApiListModelsFunction;
}): void {
  registry.set(entry.api, entry);
}

/**
 * Look up the stream function for the given API wire format.
 * Throws if no provider is registered.
 */
export function getApiStream(api: string): ApiStreamFunction {
  const entry = registry.get(api);
  if (!entry) throw new Error(`No API provider registered for: ${api}`);
  return entry.stream;
}

/**
 * Look up the model lister for the given API wire format.
 * Throws if no provider is registered.
 */
export function getApiListModels(api: string): ApiListModelsFunction {
  const entry = registry.get(api);
  if (!entry) throw new Error(`No API provider registered for: ${api}`);
  return entry.listModels;
}

/**
 * Check if a provider is registered for the given API.
 */
export function hasApiProvider(api: string): boolean {
  return registry.has(api);
}

/**
 * Clear all registered providers (useful for testing).
 */
export function clearApiProviders(): void {
  registry.clear();
}

/**
 * Get all registered API keys.
 */
export function getRegisteredApis(): string[] {
  return [...registry.keys()];
}
