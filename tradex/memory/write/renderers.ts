export function stripJsonFence(content: string): string {
  return content.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
}

export function parseJsonObject(content: string): Record<string, unknown> {
  const parsed = JSON.parse(stripJsonFence(content)) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("expected JSON object");
  return parsed as Record<string, unknown>;
}

export function redactSecrets(text: string): string {
  return text.replace(/(api[_-]?key|secret|token|passphrase)\s*[:=]\s*\S+/gi, "$1=<redacted>");
}

export function clipText(text: string, input: { limit: number }): string {
  return text.length > input.limit ? `${text.slice(0, input.limit - 3)}...` : text;
}
