import { execFile } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { ToolRegistry } from "../tools/registry.js";
import { CliRunGrantStore, prepareTradexCli } from "./cli-tools.js";

const execFileAsync = promisify(execFile);

describe("Tradex CLI run grants", () => {
  it("captures only the external Runtime allowlist and revokes it", () => {
    const registry = new ToolRegistry();
    registry.register({
      name: "quote",
      description: "Read quote",
      parameters: { type: "object" },
      policy: { access: "read", domain: "market", runtimeExposure: ["claude-code"] },
      execute: () => "ok",
    });
    registry.register({
      name: "place_order",
      description: "Place order",
      parameters: { type: "object" },
      policy: { access: "write", domain: "trading", runtimeExposure: ["claude-code"] },
      execute: () => "blocked",
    });
    const grants = new CliRunGrantStore({ now: () => 1_000 });
    const issued = grants.issue({
      tradexSessionId: "s1",
      registry,
      ttlMs: 60_000,
      runtime: "claude-code",
    });

    expect(grants.resolve(issued.token)?.tools.map((tool) => tool.name)).toEqual(["quote"]);
    grants.revoke(issued.token);
    expect(grants.resolve(issued.token)).toBeNull();
  });

  it("expires grants", () => {
    let now = 1_000;
    const grants = new CliRunGrantStore({ now: () => now });
    const issued = grants.issue({
      tradexSessionId: "s1",
      registry: new ToolRegistry(),
      ttlMs: 10,
      runtime: "cursor",
    });
    now = 1_011;
    expect(grants.resolve(issued.token)).toBeNull();
  });

  it("keeps the full registry for the Pi CLI adapter", () => {
    const registry = new ToolRegistry();
    registry.register({
      name: "read_market",
      description: "Read market data",
      parameters: { type: "object" },
      execute: () => "ok",
    });
    registry.register({
      name: "place_order",
      description: "Place an order",
      parameters: { type: "object" },
      policy: { access: "write", domain: "trading", runtimeExposure: ["pi"] },
      execute: () => "ok",
    });

    const grants = new CliRunGrantStore();
    const issued = grants.issue({
      tradexSessionId: "pi-session",
      registry,
      ttlMs: 60_000,
      runtime: "pi",
    });

    expect(grants.resolve(issued.token)?.tools.map((tool) => tool.name)).toEqual([
      "read_market",
      "place_order",
    ]);
  });
});

describe("Tradex CLI command", () => {
  it("writes a syntax-valid command and prepends it to PATH", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "tradex-cli-"));
    const prepared = await prepareTradexCli({ cwd, url: "http://127.0.0.1:8765/cli/tradex", token: "secret" });
    const script = prepared.env.TRADEX_CLI_SCRIPT;
    const binDir = path.dirname(script!);
    expect(script).toBeTruthy();
    expect(prepared.env.PATH?.split(path.delimiter)[0]).toBe(binDir);
    expect(await readFile(path.join(binDir, "tradex"), "utf8")).toContain("TRADEX_CLI_SCRIPT");
    await expect(execFileAsync(process.execPath, ["--check", script!])).resolves.toMatchObject({ stderr: "" });
    await prepared.cleanup();
  });
});
