import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { detectClaudeCode } from "./availability.js";

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
