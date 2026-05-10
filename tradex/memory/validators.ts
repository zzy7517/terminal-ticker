export class MemoryValidationError extends Error {}

export function validateFactText(text: string): void {
  if (!text.trim()) throw new MemoryValidationError("fact text is required");
}

export function validateReviewMetadata(metadata: Record<string, unknown>): void {
  if (!metadata || typeof metadata !== "object") throw new MemoryValidationError("metadata must be an object");
}
