import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  invalidateSecretsCache,
  isSecretRef,
  lookupSecret,
  persistSecret,
  secretsFilePath,
  storeSecret,
} from "./secrets.js";
import { loadConfig } from "./index.js";
import { updateJin10ConfigInWatchlist } from "./watchlist-store.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), "tradex-secrets-"));
  process.env.TRADEX_SECRETS_FILE = path.join(tmpDir, "secrets.toml");
  invalidateSecretsCache();
});

afterEach(() => {
  delete process.env.TRADEX_SECRETS_FILE;
  delete process.env.TRADEX_TEST_ENV_SECRET;
  invalidateSecretsCache();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("secrets vault", () => {
  it("round-trips a stored secret", () => {
    storeSecret("MY_TOKEN", "s3cret-value");
    expect(lookupSecret("MY_TOKEN")).toBe("s3cret-value");

    // Survives a cache drop (i.e. is actually on disk).
    invalidateSecretsCache();
    expect(lookupSecret("MY_TOKEN")).toBe("s3cret-value");
  });

  it("creates the vault file with owner-only permissions", () => {
    storeSecret("MY_TOKEN", "v");
    const mode = statSync(secretsFilePath()).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("falls back to process.env when the vault has no entry", () => {
    process.env.TRADEX_TEST_ENV_SECRET = "from-env";
    expect(lookupSecret("TRADEX_TEST_ENV_SECRET")).toBe("from-env");
  });

  it("prefers the vault over process.env", () => {
    process.env.TRADEX_TEST_ENV_SECRET = "from-env";
    storeSecret("TRADEX_TEST_ENV_SECRET", "from-vault");
    expect(lookupSecret("TRADEX_TEST_ENV_SECRET")).toBe("from-vault");
  });

  it("keeps existing entries when storing another secret", () => {
    storeSecret("FIRST", "a");
    storeSecret("SECOND", "b");
    expect(lookupSecret("FIRST")).toBe("a");
    expect(lookupSecret("SECOND")).toBe("b");
  });

  it("rejects invalid secret names", () => {
    expect(() => storeSecret("BAD NAME", "v")).toThrow();
  });
});

describe("isSecretRef", () => {
  it("accepts exactly one ${NAME}", () => {
    expect(isSecretRef("${JIN10_TOKEN}")).toBe(true);
    expect(isSecretRef("  ${JIN10_TOKEN} ")).toBe(true);
  });

  it("rejects literals and mixed strings", () => {
    expect(isSecretRef("sk-abc")).toBe(false);
    expect(isSecretRef("prefix-${VAR}")).toBe(false);
    expect(isSecretRef("")).toBe(false);
  });
});

describe("persistSecret", () => {
  it("passes ${VAR} references through untouched without writing the vault", () => {
    expect(persistSecret("${SOME_REF}", "expanded-value", "IGNORED")).toBe("${SOME_REF}");
    expect(lookupSecret("IGNORED")).toBeUndefined();
  });

  it("preserves mixed strings containing a placeholder", () => {
    expect(persistSecret("prefix-${VAR}", "prefix-x", "IGNORED")).toBe("prefix-${VAR}");
  });

  it("interns a plaintext value and returns the reference", () => {
    expect(persistSecret("sk-literal", "sk-literal", "MY_KEY")).toBe("${MY_KEY}");
    expect(lookupSecret("MY_KEY")).toBe("sk-literal");
  });

  it("interns the resolved value when no raw form is known", () => {
    expect(persistSecret(undefined, "sk-literal", "MY_KEY")).toBe("${MY_KEY}");
    expect(lookupSecret("MY_KEY")).toBe("sk-literal");
  });

  it("returns empty for a cleared secret", () => {
    expect(persistSecret("", "", "MY_KEY")).toBe("");
    expect(persistSecret(undefined, "   ", "MY_KEY")).toBe("");
    expect(lookupSecret("MY_KEY")).toBeUndefined();
  });
});

describe("watchlist round-trip", () => {
  it("never writes a plaintext token to the TOML", async () => {
    const watchlistPath = path.join(tmpDir, "watchlist.toml");
    writeFileSync(
      watchlistPath,
      [
        "symbols = [",
        '  { symbol = "BTCUSDT", source = "bitget", inst_type = "USDT-FUTURES" },',
        "]",
        "",
        "[jin10]",
        "enabled = true",
        'token = ""',
        "",
      ].join("\n"),
    );

    const config = await loadConfig(watchlistPath);
    await updateJin10ConfigInWatchlist(watchlistPath, {
      ...config.jin10,
      token: "sk-pasted-from-ui",
      tokenRaw: "sk-pasted-from-ui",
    });

    const text = readFileSync(watchlistPath, "utf8");
    expect(text).not.toContain("sk-pasted-from-ui");
    expect(text).toContain('token = "${JIN10_TOKEN}"');
    expect(lookupSecret("JIN10_TOKEN")).toBe("sk-pasted-from-ui");

    // Reloading resolves the reference back to the pasted value.
    const reloaded = await loadConfig(watchlistPath);
    expect(reloaded.jin10.token).toBe("sk-pasted-from-ui");
    expect(reloaded.jin10.tokenRaw).toBe("${JIN10_TOKEN}");
  });
});
