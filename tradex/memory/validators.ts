const INFERENCE_TERMS = [
  "因为",
  "导致",
  "容易",
  "应该",
  "总是",
  "倾向",
  "说明",
  "证明",
  "caused",
  "because",
  "should",
  "always",
  "likely",
  "proves",
];

export class MemoryValidationError extends Error {}

export function validateFactText(text: string): void {
  const content = text.trim();
  if (!content) throw new MemoryValidationError("fact text must not be empty");
  const lowered = content.toLowerCase();
  for (const term of INFERENCE_TERMS) {
    if (lowered.includes(term.toLowerCase())) {
      throw new MemoryValidationError(`fact text contains inference term: ${term}`);
    }
  }
}

export function validateReviewMetadata(metadata: Record<string, unknown>): void {
  if (!metadata || typeof metadata !== "object") {
    throw new MemoryValidationError("metadata must be an object");
  }
  const basedOn = metadata.based_on;
  if (
    !Array.isArray(basedOn) ||
    basedOn.length === 0 ||
    !basedOn.every((item) => typeof item === "string" && item)
  ) {
    throw new MemoryValidationError("review metadata must include non-empty based_on fact ids");
  }
  const sampleCount = metadata.sample_count;
  if (typeof sampleCount !== "number" || !Number.isInteger(sampleCount) || sampleCount < 1) {
    throw new MemoryValidationError("review metadata sample_count must be a positive integer");
  }
}
