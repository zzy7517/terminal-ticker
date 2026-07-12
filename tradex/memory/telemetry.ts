import type { Usage } from "@earendil-works/pi-ai";
import { redactStructuredValue } from "./write/renderers.js";

type MemoryLogLevel = "debug" | "info" | "warn" | "error";

export function memoryLog(
  level: MemoryLogLevel,
  event: string,
  fields: object = {},
): void {
  const payload = {
    ts: new Date().toISOString(),
    component: "memory",
    event,
    ...redactStructuredValue(fields),
  };
  const line = `[memory] ${JSON.stringify(payload)}`;
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else if (level === "debug") console.debug(line);
  else console.info(line);
}

export function usageFields(
  usage: Pick<Usage, "input" | "output" | "cacheRead" | "cacheWrite" | "totalTokens"> | null | undefined,
): Record<string, number> {
  if (!usage) return {};
  return {
    input_tokens: usage.input,
    output_tokens: usage.output,
    cache_read_tokens: usage.cacheRead,
    cache_write_tokens: usage.cacheWrite,
    total_tokens: usage.totalTokens,
  };
}

export function elapsedMs(startedAtMs: number, now = Date.now()): number {
  return Math.max(0, now - startedAtMs);
}
