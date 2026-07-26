import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { OriginMaterializationConflictError, OriginSessionStore } from "./session-store.js";

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
    });

    const session = (await new OriginSessionStore(root).response(id)).session;
    expect(session).toMatchObject({ runtime });
    expect(session?.workspace.startsWith(path.join(root, "workspaces") + path.sep)).toBe(true);
  });

  it("owns a random workspace and materialization key for a new Origin", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tradex-origin-"));
    dirs.push(root);
    const store = new OriginSessionStore(root);
    const { id } = store.create({
      materializationId: "draft-123",
      runtime: "claude-code",
      model: "sonnet",
      systemPrompt: "Use the configured instructions",
    });
    const metadata = store.getMetadata(id);

    expect(metadata).toMatchObject({
      id,
      materializationId: "draft-123",
      workspaceOwned: true,
      snapshot: { systemPrompt: "Use the configured instructions" },
    });
    expect(metadata?.workspace).toMatch(new RegExp(`^${escapeRegExp(path.join(root, "workspaces"))}${escapeRegExp(path.sep)}`));
    expect(fs.statSync(metadata!.workspace).isDirectory()).toBe(true);
    expect(new OriginSessionStore(root).sessionIdForMaterialization("draft-123")).toBe(id);

    expect(() => store.create({
      materializationId: "draft-123",
      runtime: "cursor",
      model: "default",
    })).toThrowError(expect.objectContaining<Partial<OriginMaterializationConflictError>>({ sessionId: id }));
    expect((await store.history(new Set())).sessions).toHaveLength(1);

    const workspace = metadata!.workspace;
    expect(await store.remove(id)).toBe(true);
    expect(fs.existsSync(workspace)).toBe(false);
  });

  it("does not own an external workspace even when metadata claims ownership", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tradex-origin-"));
    const externalWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), "tradex-shared-workspace-"));
    dirs.push(root, externalWorkspace);
    const store = new OriginSessionStore(root);
    const { id } = store.create({ runtime: "claude-code", model: "sonnet" });
    const metadataFile = path.join(root, "registry", `${id}.json`);
    const metadata = JSON.parse(fs.readFileSync(metadataFile, "utf8")) as Record<string, unknown>;
    fs.writeFileSync(metadataFile, `${JSON.stringify({
      ...metadata,
      workspace: externalWorkspace,
      workspaceOwned: true,
    }, null, 2)}\n`);

    expect(store.deletionTarget(id)).toEqual({
      runtime: "claude-code",
      workspace: externalWorkspace,
      ownsWorkspace: false,
    });
    expect(await store.remove(id)).toBe(true);
    expect(fs.existsSync(externalWorkspace)).toBe(true);
  });

  it("does not delete another Session workspace referenced by copied metadata", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tradex-origin-"));
    dirs.push(root);
    const store = new OriginSessionStore(root);
    const first = store.create({ runtime: "claude-code", model: "sonnet" });
    const second = store.create({ runtime: "claude-code", model: "opus" });
    const firstMetadataFile = path.join(root, "registry", `${first.id}.json`);
    const firstMetadata = JSON.parse(fs.readFileSync(firstMetadataFile, "utf8")) as Record<string, unknown>;
    const secondWorkspace = store.getMetadata(second.id)!.workspace;
    fs.writeFileSync(firstMetadataFile, `${JSON.stringify({
      ...firstMetadata,
      workspace: secondWorkspace,
      workspaceOwned: true,
    }, null, 2)}\n`);

    expect(store.deletionTarget(first.id)?.ownsWorkspace).toBe(false);
    expect(await store.remove(first.id)).toBe(true);
    expect(fs.existsSync(secondWorkspace)).toBe(true);
  });

  it("rejects a pre-existing symlink at the managed workspaces root", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tradex-origin-"));
    const externalRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tradex-external-workspaces-"));
    dirs.push(root, externalRoot);
    fs.symlinkSync(externalRoot, path.join(root, "workspaces"), "dir");
    const store = new OriginSessionStore(root);

    expect(() => store.create({ runtime: "claude-code", model: "sonnet" }))
      .toThrow("Origin workspaces root must be a real directory");
    expect(fs.readdirSync(externalRoot)).toEqual([]);
  });

  it("does not own a workspace symlink redirected outside the Origin root", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tradex-origin-"));
    const externalWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), "tradex-shared-workspace-"));
    dirs.push(root, externalWorkspace);
    const store = new OriginSessionStore(root);
    const { id } = store.create({ runtime: "claude-code", model: "sonnet" });
    const workspace = store.getMetadata(id)!.workspace;
    fs.rmSync(workspace, { recursive: true });
    fs.symlinkSync(externalWorkspace, workspace, "dir");

    expect(store.deletionTarget(id)).toEqual({
      runtime: "claude-code",
      workspace,
      ownsWorkspace: false,
    });
  });

  it("does not own a workspace after the managed workspace root is redirected", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tradex-origin-"));
    const externalRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tradex-shared-root-"));
    dirs.push(root, externalRoot);
    const store = new OriginSessionStore(root);
    const { id } = store.create({ runtime: "claude-code", model: "sonnet" });
    const workspace = store.getMetadata(id)!.workspace;
    const workspaceName = path.basename(workspace);
    fs.rmSync(path.join(root, "workspaces"), { recursive: true });
    fs.mkdirSync(path.join(externalRoot, workspaceName));
    fs.symlinkSync(externalRoot, path.join(root, "workspaces"), "dir");

    expect(store.deletionTarget(id)).toEqual({
      runtime: "claude-code",
      workspace,
      ownsWorkspace: false,
    });
  });

  it.skipIf(process.platform === "win32")("does not block on a FIFO workspace owner marker", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tradex-origin-"));
    dirs.push(root);
    const store = new OriginSessionStore(root);
    const { id } = store.create({ runtime: "claude-code", model: "sonnet" });
    const workspace = store.getMetadata(id)!.workspace;
    const ownerFile = path.join(workspace, ".tradex-origin-owner.json");
    fs.rmSync(ownerFile);
    execFileSync("mkfifo", [ownerFile]);

    expect(store.deletionTarget(id)).toEqual({
      runtime: "claude-code",
      workspace,
      ownsWorkspace: false,
    });
  });

  it.skipIf(process.platform === "win32")("does not block on a FIFO registry entry", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tradex-origin-"));
    dirs.push(root);
    const store = new OriginSessionStore(root);
    const { id } = store.create({ runtime: "claude-code", model: "sonnet" });
    const metadataFile = path.join(root, "registry", `${id}.json`);
    fs.rmSync(metadataFile);
    execFileSync("mkfifo", [metadataFile]);

    expect(store.getMetadata(id)).toBeNull();
    expect(store.deletionTarget(id)).toBeNull();
  });
});

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
