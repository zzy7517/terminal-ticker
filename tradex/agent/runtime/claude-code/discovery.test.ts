import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { detectClaudeCode } from "./discovery.js";
import { claudeModelCatalog } from "./model-manifest.js";

describe("Claude Code model catalog", () => {
  it("exposes the curated first-party Claude manifest", () => {
    const models = claudeModelCatalog();

    expect(models.map((model) => model.id)).toEqual([
      "claude-fable-5",
      "claude-opus-4-8[1m]",
      "claude-opus-4-8",
      "claude-sonnet-5",
      "claude-opus-4-7[1m]",
      "claude-opus-4-7",
      "claude-opus-4-6[1m]",
      "claude-opus-4-6",
      "claude-sonnet-4-6[1m]",
      "claude-sonnet-4-6",
      "claude-haiku-4-5",
    ]);
    expect(models.find((model) => model.default)?.id).toBe("claude-opus-4-8");
    expect(models.find((model) => model.id === "claude-sonnet-5")?.thinking.supportedLevels).toContain("xhigh");
    expect(models.find((model) => model.id === "claude-sonnet-4-6")?.thinking.supportedLevels).not.toContain("xhigh");
    expect(models.find((model) => model.id === "claude-haiku-4-5")?.thinking.supportedLevels).toEqual([]);
  });
});

describe("Claude Code availability", () => {
  it("reports the local CLI version", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "tradex-claude-version-"));
    const executable = path.join(directory, "claude");
    await writeFile(executable, "#!/bin/sh\necho '2.1.0 (Claude Code)'\n");
    await chmod(executable, 0o755);

    await expect(detectClaudeCode(executable)).resolves.toMatchObject({
      available: true,
      executablePath: executable,
      version: "2.1.0 (Claude Code)",
      error: null,
    });
  });

  it("returns an unavailable result instead of throwing", async () => {
    await expect(detectClaudeCode("/definitely/missing/claude")).resolves.toMatchObject({
      available: false,
      version: null,
    });
  });

  it("marks a CLI without project purge support as unavailable", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "tradex-claude-version-"));
    const executable = path.join(directory, "claude");
    await writeFile(executable, "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then echo '1.0.0'; exit 0; fi\necho 'unknown command' >&2\nexit 2\n");
    await chmod(executable, 0o755);

    await expect(detectClaudeCode(executable)).resolves.toMatchObject({
      available: false,
      version: "1.0.0",
      error: expect.stringContaining("does not support project purge"),
    });
  });
});
