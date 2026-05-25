import type { AgentContextUsage, AgentModelOption } from '../types';

export function fallbackContextWindow(provider: string, model: string): number | null {
  const normalizedProvider = provider.toLowerCase();
  const id = `${normalizedProvider}:${model}`.toLowerCase();
  if (normalizedProvider === 'anthropic' || id.includes('claude')) return 200_000;
  if (id.includes('gpt-5') || id.includes('gpt-4.1') || id.includes('gpt-4o')) return 128_000;
  return null;
}

export function resolveContextWindow(
  provider: string,
  model: string,
  modelCache: Record<string, AgentModelOption[]>,
): number | null {
  const normalizedProvider = provider.toLowerCase();
  const cached = (modelCache[provider] ?? modelCache[normalizedProvider] ?? []).find((item) => item.slug === model)?.contextWindow ?? null;
  if (cached && cached > 0) return cached;
  return fallbackContextWindow(provider, model);
}

export function contextTokenCount(usage: AgentContextUsage | null | undefined): number | null {
  if (!usage) return null;
  const value = usage.tokens ?? usage.promptTokens ?? usage.totalTokens ?? null;
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

export function contextUsagePercent(
  usage: AgentContextUsage | null | undefined,
  contextWindow: number | null,
): number | null {
  const explicitPercent = usage?.percent;
  if (typeof explicitPercent === 'number' && Number.isFinite(explicitPercent) && explicitPercent >= 0) return explicitPercent;
  const resolvedContextWindow = contextWindow ?? usage?.contextWindow ?? null;
  const tokens = contextTokenCount(usage);
  if (tokens === null || !resolvedContextWindow || resolvedContextWindow <= 0) return null;
  return (tokens / resolvedContextWindow) * 100;
}

export function formatContextPercent(percent: number | null): string | null {
  if (percent === null) return null;
  return percent > 0 && percent < 1 ? '<1' : String(Math.round(percent));
}
