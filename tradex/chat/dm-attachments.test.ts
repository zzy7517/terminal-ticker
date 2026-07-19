import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildDmMessageContent, saveDmImageAttachments } from "./dm-attachments.js";

describe("dm-attachments", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) {
      fs.rmSync(root, { recursive: true, force: true });
    }
    vi.restoreAllMocks();
  });

  it("saves images under private workspace and builds fabric content", async () => {
    const cache = fs.mkdtempSync(path.join(os.tmpdir(), "tradex-dm-attach-"));
    roots.push(cache);
    vi.stubEnv("XDG_CACHE_HOME", cache);
    // defaultCacheDir uses XDG_CACHE_HOME/tradex — ensurePrivateWorkspace follows that.
    const png = Buffer.from("89504e470d0a1a0a", "hex").toString("base64");
    const paths = saveDmImageAttachments("alpha", [{ data: png, mimeType: "image/png" }]);
    expect(paths).toHaveLength(1);
    expect(paths[0]).toMatch(/^dm-attachments\/.+\.png$/);
    const content = buildDmMessageContent("", paths);
    expect(content).toContain("分析这张图片");
    expect(content).toContain(paths[0]);
    const abs = path.join(cache, "tradex", "agent_contexts", "alpha", "workspace", paths[0]);
    expect(fs.existsSync(abs)).toBe(true);
  });
});
