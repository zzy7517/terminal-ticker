import { lookupSecret, secretsFilePath } from "./secrets.js";

export function asRecord(value: unknown, field: string): Record<string, unknown> {
  if (value === null || value === undefined) return {};
  if (typeof value !== "object" || Array.isArray(value)) throw new Error(`${field} must be a table`);
  return value as Record<string, unknown>;
}

export function normalizeBool(rawValue: unknown, fieldName: string, defaultValue: boolean): boolean {
  if (rawValue === null || rawValue === undefined) return defaultValue;
  if (typeof rawValue === "boolean") return rawValue;
  if (typeof rawValue === "string") {
    const normalized = rawValue.trim().toLowerCase();
    if (["1", "true", "yes", "on"].includes(normalized)) return true;
    if (["0", "false", "no", "off"].includes(normalized)) return false;
  }
  throw new Error(`${fieldName} must be a boolean`);
}

export function coerceInt(rawValue: unknown, fieldName: string, defaultValue: number): number {
  if (rawValue === null || rawValue === undefined) return defaultValue;
  let value: number;
  if (typeof rawValue === "string") {
    const trimmed = rawValue.trim();
    if (!/^[+-]?\d+$/.test(trimmed)) throw new Error(`${fieldName} must be an integer`);
    value = Number.parseInt(trimmed, 10);
  } else if (typeof rawValue === "number") {
    if (!Number.isInteger(rawValue)) throw new Error(`${fieldName} must be an integer`);
    value = rawValue;
  } else {
    throw new Error(`${fieldName} must be an integer`);
  }
  if (value <= 0) throw new Error(`${fieldName} must be positive`);
  return value;
}

export function coerceMinInt(rawValue: unknown, fieldName: string, defaultValue: number, minimum: number): number {
  const value = coerceInt(rawValue, fieldName, defaultValue);
  if (value < minimum) throw new Error(`${fieldName} must be at least ${minimum}`);
  return value;
}

export function coerceFloat(rawValue: unknown, fieldName: string, defaultValue: number): number {
  if (rawValue === null || rawValue === undefined) return defaultValue;
  const value = Number(rawValue);
  if (!Number.isFinite(value)) throw new Error(`${fieldName} must be a number`);
  if (value <= 0) throw new Error(`${fieldName} must be positive`);
  return value;
}

// Expands ${VAR} / $VAR references against the secrets vault first, then
// process.env. Unset variables expand to an empty string (with a warning) so a
// missing secret fails loudly rather than leaking a literal "${VAR}" to a
// provider.
export function expandEnvRefs(value: string, field: string): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (_match, braced, bare) => {
    const name = braced ?? bare;
    const resolved = lookupSecret(name);
    if (resolved === undefined) {
      console.warn(
        `[config] secret "${name}" referenced by ${field} is set neither in ${secretsFilePath()} nor in the environment`,
      );
      return "";
    }
    return resolved;
  });
}

/**
 * Parse one secret-bearing config field into its resolved value plus the
 * original TOML string. Serializers persist the raw form, so "${VAR}"
 * references round-trip instead of leaking the expanded secret to disk.
 */
export function parseSecretField(rawValue: unknown, field: string): { value: string; raw: string } {
  const raw = typeof rawValue === "string" ? rawValue.trim() : "";
  return { raw, value: raw ? expandEnvRefs(raw, field) : "" };
}
