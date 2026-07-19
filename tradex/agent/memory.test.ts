import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  memoryApplyRetention,
  memoryCompact,
  memoryRead,
  memorySearch,
  memoryWrite,
} from "./memory.js";
import { ensurePrivateWorkspace } from "./private-workspace.js";

describe("per-Agent memory hardening", () => {
  let previousCache: string | undefined;
  let root: string;

  beforeEach(() => {
    previousCache = process.env.XDG_CACHE_HOME;
    root = fs.mkdtempSync(path.join(os.tmpdir(), "tradex-memory-"));
    process.env.XDG_CACHE_HOME = root;
  });

  afterEach(() => {
    if (previousCache === undefined) delete process.env.XDG_CACHE_HOME;
    else process.env.XDG_CACHE_HOME = previousCache;
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("reads, writes, and searches isolated MEMORY.md", () => {
    memoryWrite("alpha", "# Memory for alpha\n\nBTC bias: bullish\n");
    memoryWrite("beta", "# Memory for beta\n\nBTC bias: bearish\n");
    expect(memoryRead("alpha")).toContain("bullish");
    expect(memorySearch("alpha", "bullish")).toEqual([
      expect.objectContaining({ text: expect.stringContaining("bullish") }),
    ]);
    expect(memorySearch("beta", "bullish")).toEqual([]);
  });

  it("compacts oversized memory and archives overflow", () => {
    const pad = "x".repeat(60_000);
    memoryWrite("alpha", `# Memory for alpha\n\n${pad}\n`);
    const result = memoryCompact("alpha", 1_000);
    expect(result.truncated).toBe(true);
    expect(result.afterChars).toBeLessThanOrEqual(1_200);
    expect(memoryRead("alpha").length).toBeLessThan(2_000);
    const archiveDir = path.join(ensurePrivateWorkspace("alpha").root, "memory", "archive");
    expect(fs.readdirSync(archiveDir).length).toBeGreaterThan(0);
  });

  it("archives stale workspace notes without touching MEMORY.md", () => {
    const workspace = ensurePrivateWorkspace("alpha");
    const notesDir = path.join(workspace.workspacePath, "notes");
    fs.mkdirSync(notesDir, { recursive: true });
    const notePath = path.join(notesDir, "old.md");
    fs.writeFileSync(notePath, "old note", "utf8");
    const old = Date.now() - 200 * 24 * 60 * 60 * 1000;
    fs.utimesSync(notePath, new Date(old), new Date(old));
    memoryWrite("alpha", "# Memory for alpha\n\nkeep me\n");
    const result = memoryApplyRetention("alpha", 180, Date.now());
    expect(result.archivedNotes).toBe(1);
    expect(fs.existsSync(notePath)).toBe(false);
    expect(memoryRead("alpha")).toContain("keep me");
  });
});
