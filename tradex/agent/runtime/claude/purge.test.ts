import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { purgeClaudeProject } from "./purge.js";

describe("Claude Code project purge", () => {
  it("uses the native project purge command with the exact Session directory", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "tradex-claude-purge-"));
    const executable = path.join(directory, "fake-claude.mjs");
    const output = path.join(directory, "argv.json");
    await writeFile(executable, `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(output)}, JSON.stringify(process.argv.slice(2)));
`);
    await chmod(executable, 0o755);

    await purgeClaudeProject(executable, path.join(directory, "session"));

    await expect(readFile(output, "utf8").then(JSON.parse)).resolves.toEqual([
      "project", "purge", path.join(directory, "session"), "--yes",
    ]);
  });

  it("rejects when Claude refuses the purge", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "tradex-claude-purge-"));
    const executable = path.join(directory, "fake-claude.mjs");
    await writeFile(executable, "#!/usr/bin/env node\nprocess.stderr.write('cannot purge'); process.exit(7);\n");
    await chmod(executable, 0o755);

    await expect(purgeClaudeProject(executable, directory)).rejects.toThrow("cannot purge");
  });

  it("treats missing project state as an idempotent success", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "tradex-claude-purge-"));
    const executable = path.join(directory, "fake-claude.mjs");
    await writeFile(executable, "#!/usr/bin/env node\nprocess.stderr.write('No project state found'); process.exit(1);\n");
    await chmod(executable, 0o755);

    await expect(purgeClaudeProject(executable, directory)).resolves.toBeUndefined();
  });
});
