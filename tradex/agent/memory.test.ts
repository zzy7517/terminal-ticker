import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  memoryApplyRetention,
  memoryCompact,
  memoryRead,
  memorySearch,
  memoryWrite,
} from "./memory.js";
import { ensurePrivateWorkspace } from "./private-workspace.js";

describe("per-Agent memory hardening", () => {
  let previousHome: string | undefined;
  let root: string;

  // defaultCacheDir() memoizes its result, so TRADEX_HOME must point at the
  // sandbox before the first store path resolves — one root for the whole file.
  beforeAll(() => {
    previousHome = process.env.TRADEX_HOME;
    root = fs.mkdtempSync(path.join(os.tmpdir(), "tradex-memory-"));
    // Pre-create data/ so the legacy XDG migration branch can never run
    // against the developer's real ~/.cache/tradex.
    fs.mkdirSync(path.join(root, "data"), { recursive: true });
    process.env.TRADEX_HOME = root;
  });

  afterAll(() => {
    if (previousHome === undefined) delete process.env.TRADEX_HOME;
    else process.env.TRADEX_HOME = previousHome;
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

  it("keeps every write inside the TRADEX_HOME sandbox", () => {
    const workspace = ensurePrivateWorkspace("alpha");
    expect(workspace.root.startsWith(root)).toBe(true);
  });
});
