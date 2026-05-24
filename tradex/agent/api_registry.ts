/**
 * api_registry.ts — Global API provider registry.
 *
 * Maps API wire-format strings (e.g. "codex_responses", "anthropic_messages")
 * to stateless stream functions. This is the central dispatch layer that
 * makes model switching a pointer swap rather than a provider rebuild.
 *
 * Modeled after pi-mono's api-registry. Provider stream functions speak the
 * same typed contract the core Agent expects: a typed `AgentContext` in,
 * a `StreamResult` out. There is no intermediate `ChatInput`/`ChatResponse`
 * stringly-typed bridge.
 */

import type { AgentContext, StreamFn, StreamOptions, StreamResult, AgentModelDescriptor } from "./core/types.js";

/**
 * Stateless stream function registered for a wire-format API.
 * Same shape as core `StreamFn` — providers are the implementation.
 */
export type ApiStreamFunction = StreamFn;

/**
 * Stateless model lister. Receives the same model descriptor the stream
 * function would, and returns the provider's raw model option list.
 */
export type ApiListModelsFunction = (
  model: AgentModelDescriptor,
  options?: { apiKey?: string },
) => Promise<Array<Record<string, unknown>>>;

interface RegisteredProvider {
  api: string;
  stream: ApiStreamFunction;
  listModels: ApiListModelsFunction;
}

const registry = new Map<string, RegisteredProvider>();

/** Register a provider's stream + listModels under an API wire-format key. */
export function registerApiProvider(entry: {
  api: string;
  stream: ApiStreamFunction;
  listModels: ApiListModelsFunction;
}): void {
  registry.set(entry.api, entry);
}

/** Look up the stream function for the given API. Throws if missing. */
export function getApiStream(api: string): ApiStreamFunction {
  const entry = registry.get(api);
  if (!entry) throw new Error(`No API provider registered for: ${api}`);
  return entry.stream;
}

/** Look up the model lister for the given API. Throws if missing. */
export function getApiListModels(api: string): ApiListModelsFunction {
  const entry = registry.get(api);
  if (!entry) throw new Error(`No API provider registered for: ${api}`);
  return entry.listModels;
}

/** Check if a provider is registered for the given API. */
export function hasApiProvider(api: string): boolean {
  return registry.has(api);
}

/** Clear all registered providers (testing). */
export function clearApiProviders(): void {
  registry.clear();
}

/** All registered API keys. */
export function getRegisteredApis(): string[] {
  return [...registry.keys()];
}

// Re-export the core types so call sites can import from one place.
export type { StreamFn, StreamOptions, StreamResult, AgentContext };
