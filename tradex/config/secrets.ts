/**
 * Local secrets vault.
 *
 * The watchlist TOML is designed to be shareable (and often lives in a git
 * repo), so secrets must never be written into it. They live here instead:
 *
 *   ~/.tradex/secrets.toml   (file mode 600; see tradexHome() in db.ts)
 *
 * Config values reference secrets as "${NAME}". Resolution order is vault
 * first, then process.env — the vault wins because it is what the UI writes
 * to, and a save from the settings panel must take effect deterministically
 * even when a stale value lingers in the shell environment. Values that only
 * ever existed as environment variables (e.g. "${OPENAI_API_KEY}" exported in
 * the shell) keep working unchanged, since the vault simply has no entry.
 *
 * `persistSecret` is the write-side chokepoint: every watchlist serializer
 * routes secret fields through it, so a caller that passes a plaintext secret
 * gets it interned into the vault and only the "${NAME}" reference reaches
 * the TOML — regardless of whether the value came from the UI, an agent tool,
 * or a programmatic config update.
 */

import fs from "node:fs";
import path from "node:path";
import { parse as parseToml } from "smol-toml";
import { tradexHome } from "../db.js";

/** Matches a value that is exactly one "${NAME}" reference. */
const SECRET_REF_RE = /^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/;
const VALID_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function secretsFilePath(): string {
  const override = process.env.TRADEX_SECRETS_FILE;
  if (override && override.trim()) return path.resolve(override.trim());
  return path.join(tradexHome(), "secrets.toml");
}

let cache: { path: string; values: Record<string, string> } | null = null;

function readVault(): Record<string, string> {
  const file = secretsFilePath();
  if (cache && cache.path === file) return cache.values;

  let values: Record<string, string> = {};
  try {
    const parsed = parseToml(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
    values = Object.fromEntries(
      Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      console.warn(
        `[secrets] failed to read ${file}:`,
        error instanceof Error ? error.message : error,
      );
    }
  }

  cache = { path: file, values };
  return values;
}

/** Drop the in-memory copy so the next lookup re-reads the file. */
export function invalidateSecretsCache(): void {
  cache = null;
}

/** Resolve one secret by name: vault first, then process.env. */
export function lookupSecret(name: string): string | undefined {
  const fromVault = readVault()[name];
  if (fromVault !== undefined && fromVault !== "") return fromVault;
  const fromEnv = process.env[name];
  return fromEnv !== undefined && fromEnv !== "" ? fromEnv : undefined;
}

/** Whether `value` is exactly a "${NAME}" secret reference. */
export function isSecretRef(value: string): boolean {
  return SECRET_REF_RE.test(value.trim());
}

function tomlEscape(value: string): string {
  return `"${value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\r/g, "\\r")
    .replace(/\n/g, "\\n")
    .replace(/\t/g, "\\t")}"`;
}

/**
 * Insert or update one secret in the vault file.
 *
 * The whole file is rewritten from the parsed map, which drops manual
 * comments — acceptable for a machine-managed vault, and it keeps the write
 * path free of line-splicing edge cases.
 */
export function storeSecret(name: string, value: string): void {
  if (!VALID_NAME_RE.test(name)) throw new Error(`invalid secret name: ${name}`);

  const file = secretsFilePath();
  const values = { ...readVault(), [name]: value };

  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const body = Object.entries(values)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, val]) => `${key} = ${tomlEscape(val)}`)
    .join("\n");
  fs.writeFileSync(file, `${body}\n`, { mode: 0o600 });
  try {
    // mode in writeFileSync only applies on creation; tighten pre-existing files.
    fs.chmodSync(file, 0o600);
  } catch {
    // Non-POSIX filesystems — nothing to tighten.
  }

  cache = { path: file, values };
}

/**
 * Compute the value a watchlist serializer may write to the TOML for a secret
 * field. Returns either "" (secret cleared), a "${NAME}"-style reference, or
 * — after interning a plaintext value into the vault — the fresh reference.
 *
 * `raw` is the original TOML string when known (may itself be a reference or,
 * for UI-entered secrets, the same plaintext as `value`). A raw that contains
 * a "${" placeholder is trusted verbatim so hand-written refs, including
 * mixed strings like "prefix-${VAR}", round-trip untouched.
 */
export function persistSecret(
  raw: string | undefined,
  value: string,
  varName: string,
): string {
  if (raw && raw.includes("${")) return raw;
  const literal = (raw ?? value).trim();
  if (!literal) return "";
  storeSecret(varName, literal);
  return `\${${varName}}`;
}
