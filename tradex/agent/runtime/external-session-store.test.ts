import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { CLAUDE_CODE_CAPABILITIES } from "./capabilities.js";
import { ExternalSessionStore, type ExternalSessionSnapshot } from "./external-session-store.js";

const roots: string[] = [];

afterEach(() => roots.splice(0).forEach((root) => fs.rmSync(root, { recursive: true, force: true })));

describe("ExternalSessionStore attachment projection", () => {
  it("caps cumulative attachment hydration across a response", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tradex-external-store-"));
    roots.push(root);
    const store = new ExternalSessionStore<"claude-code", ExternalSessionSnapshot<"claude-code">>({
      root,
      runtime: "claude-code",
      runtimeLabel: "Test Claude",
      capabilities: CLAUDE_CODE_CAPABILITIES,
    });
    const metadata = store.create({
      title: "Attachment budget",
      snapshot: {
        runtime: "claude-code",
        systemPrompt: "",
        provider: null,
        model: "sonnet",
        reasoningEffort: null,
      },
    });
    const attachments = path.join(store.sessionDir(metadata.id), "attachments");
    fs.writeFileSync(path.join(attachments, "first.png"), Buffer.alloc(17 * 1024 * 1024));
    fs.writeFileSync(path.join(attachments, "second.png"), Buffer.alloc(17 * 1024 * 1024));
    for (const filename of ["first.png", "second.png"]) {
      store.appendMessage(metadata.id, {
        role: "user",
        content: "",
        metadata: { images: [{ filename, mimeType: "image/png" }] },
      });
    }

    const payload = store.payload(metadata.id)!;
    const first = (payload.messages[0]?.metadata?.images as Array<Record<string, unknown>>)[0];
    const second = (payload.messages[1]?.metadata?.images as Array<Record<string, unknown>>)[0];

    expect(first?.data).toEqual(expect.any(String));
    expect(second).toMatchObject({
      filename: "second.png",
      dataOmitted: true,
      dataOmittedReason: "response_attachment_budget_exceeded",
    });
    expect(second).not.toHaveProperty("data");
  });

  it("does not read an attachment through a redirected attachments directory", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tradex-external-store-"));
    const external = fs.mkdtempSync(path.join(os.tmpdir(), "tradex-external-secret-"));
    roots.push(root, external);
    const store = createStore(root);
    const metadata = createSession(store);
    const attachments = path.join(store.sessionDir(metadata.id), "attachments");
    fs.rmSync(attachments, { recursive: true });
    fs.writeFileSync(path.join(external, "secret.png"), "secret");
    fs.symlinkSync(external, attachments, "dir");
    store.appendMessage(metadata.id, {
      role: "user",
      content: "",
      metadata: { images: [{ filename: "secret.png", mimeType: "image/png" }] },
    });

    const image = (store.payload(metadata.id)!.messages[0]!.metadata!.images as Array<Record<string, unknown>>)[0];
    expect(image).not.toHaveProperty("data");
  });

  it.skipIf(process.platform === "win32")("does not block on a FIFO attachment", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tradex-external-store-"));
    roots.push(root);
    const store = createStore(root);
    const metadata = createSession(store);
    const filename = "trap.png";
    execFileSync("mkfifo", [path.join(store.sessionDir(metadata.id), "attachments", filename)]);
    store.appendMessage(metadata.id, {
      role: "user",
      content: "",
      metadata: { images: [{ filename, mimeType: "image/png" }] },
    });

    const image = (store.payload(metadata.id)!.messages[0]!.metadata!.images as Array<Record<string, unknown>>)[0];
    expect(image).not.toHaveProperty("data");
  });

  it("rejects metadata copied from another Session directory", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tradex-external-store-"));
    roots.push(root);
    const store = createStore(root);
    const first = createSession(store);
    const second = createSession(store);
    fs.copyFileSync(
      path.join(store.sessionDir(second.id), "metadata.json"),
      path.join(store.sessionDir(first.id), "metadata.json"),
    );

    expect(store.getMetadata(first.id)).toBeNull();
    expect(() => store.setNativeSessionId(first.id, "hijacked")).toThrow("Session not found");
    expect(store.getMetadata(second.id)?.nativeSessionId).toBeNull();
  });

  it("does not follow the former predictable metadata temp path", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tradex-external-store-"));
    roots.push(root);
    const store = createStore(root);
    const metadata = createSession(store);
    const victim = path.join(root, "victim.txt");
    const metadataFile = path.join(store.sessionDir(metadata.id), "metadata.json");
    fs.writeFileSync(victim, "sentinel");
    fs.symlinkSync(victim, `${metadataFile}.${process.pid}.tmp`);

    store.beginRun(metadata.id);

    expect(fs.readFileSync(victim, "utf8")).toBe("sentinel");
    expect(store.getMetadata(metadata.id)?.lastRun?.status).toBe("running");
  });

  it.skipIf(process.platform === "win32")("does not block on FIFO metadata or transcript files", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tradex-external-store-"));
    roots.push(root);
    const store = createStore(root);
    const metadata = createSession(store);
    const directory = store.sessionDir(metadata.id);
    const metadataFile = path.join(directory, "metadata.json");
    fs.rmSync(metadataFile);
    execFileSync("mkfifo", [metadataFile]);

    expect(store.getMetadata(metadata.id)).toBeNull();

    fs.rmSync(metadataFile);
    fs.writeFileSync(metadataFile, `${JSON.stringify(metadata)}\n`);
    const transcript = path.join(directory, "session.jsonl");
    execFileSync("mkfifo", [transcript]);
    expect(store.messages(metadata.id)).toEqual([]);
    expect(() => store.appendMessage(metadata.id, { role: "user", content: "blocked" })).toThrow();
  });

  it("does not append a transcript through a symlink", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tradex-external-store-"));
    roots.push(root);
    const store = createStore(root);
    const metadata = createSession(store);
    const victim = path.join(root, "victim.txt");
    fs.writeFileSync(victim, "sentinel");
    fs.symlinkSync(victim, path.join(store.sessionDir(metadata.id), "session.jsonl"));

    expect(() => store.appendMessage(metadata.id, { role: "user", content: "redirected" })).toThrow();
    expect(fs.readFileSync(victim, "utf8")).toBe("sentinel");
  });
});

function createStore(root: string) {
  return new ExternalSessionStore<"claude-code", ExternalSessionSnapshot<"claude-code">>({
    root,
    runtime: "claude-code",
    runtimeLabel: "Test Claude",
    capabilities: CLAUDE_CODE_CAPABILITIES,
  });
}

function createSession(store: ReturnType<typeof createStore>) {
  return store.create({
    title: "Test Session",
    snapshot: {
      runtime: "claude-code",
      systemPrompt: "",
      provider: null,
      model: "sonnet",
      reasoningEffort: null,
    },
  });
}
