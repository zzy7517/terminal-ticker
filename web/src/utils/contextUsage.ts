import type { AgentContextUsage, AgentModelRegistry } from '../types';

export function resolveContextWindow(
  provider: string,
  model: string,
  registry: AgentModelRegistry | null,
): number | null {
  const exact = registry?.models.find((item) => item.providerId === provider && item.id === model);
  if (exact?.contextWindow && exact.contextWindow > 0) return exact.contextWindow;
  const idMatches = registry?.models.filter((item) => item.id === model) ?? [];
  return idMatches.length === 1 && idMatches[0].contextWindow > 0
    ? idMatches[0].contextWindow
    : null;
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
