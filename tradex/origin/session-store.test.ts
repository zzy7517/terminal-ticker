import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { OriginSessionStore } from "./session-store.js";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));

describe("OriginSessionStore", () => {
  it("persists an empty identity-free Origin across Store instances", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tradex-origin-"));
    dirs.push(root);
    const store = new OriginSessionStore(root);
    const { id, manager } = store.create({
      title: "Inspect a strategy",
      runtime: "pi",
      provider: "codex",
      model: "gpt-5.4",
      reasoningEffort: "high",
    });

    expect(manager).toBeDefined();
    const reopened = new OriginSessionStore(root);
    const payload = await reopened.response(id);
    const history = await reopened.history(new Set());

    expect(payload.session).toMatchObject({
      id,
      title: "Inspect a strategy",
      owner: { kind: "origin" },
      runtime: "pi",
    });
    expect(payload.session).not.toHaveProperty("agentId");
    expect(history.sessions).toEqual([
      expect.objectContaining({ id, owner: { kind: "origin" }, messageCount: 0 }),
    ]);
    expect(() => manager!.appendMessage({
      role: "assistant", content: [], api: "responses", provider: "openai", model: "gpt-5.4",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "stop", timestamp: Date.now(),
    } as never)).not.toThrow();
  });

  it("keeps Origin sessions inside their dedicated directory", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tradex-origin-"));
    dirs.push(root);
    const store = new OriginSessionStore(root);
    const { id, manager } = store.create({
      runtime: "pi",
      provider: "codex",
      model: "gpt-5.4",
      reasoningEffort: "medium",
    });

    expect(manager?.getSessionFile()).toContain(root);
    expect(await store.remove(id)).toBe(true);
    expect(await store.openPi(id)).toBeNull();
  });

  it.each(["pi", "claude-code", "cursor"] as const)("persists %s runtime selection", async (runtime) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tradex-origin-"));
    dirs.push(root);
    const store = new OriginSessionStore(root);
    const { id } = store.create({
      runtime,
      provider: runtime === "pi" ? "codex" : null,
      model: runtime === "pi" ? "gpt-5.4" : "default",
      reasoningEffort: runtime === "cursor" ? null : "high",
      workspace: root,
    });

    expect((await new OriginSessionStore(root).response(id)).session).toMatchObject({ runtime, workspace: root });
  });
});
