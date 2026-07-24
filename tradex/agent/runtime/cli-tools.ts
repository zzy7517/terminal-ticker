/**
 * Session-scoped CLI access to Tradex tools.
 *
 * The supported Agent runtimes already know how to run shell commands. This module
 * gives each run a short-lived, allowlisted token and a tiny `tradex` command
 * that talks to the local backend. The domain ToolRegistry remains the single
 * implementation; this is only its process adapter.
 */
import { createHash, randomBytes } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AgentRuntimeId } from "./types.js";
import type { ToolDefinition, ToolRegistry } from "../tools/registry.js";

export interface CliRunGrant {
  tradexSessionId: string;
  tools: ToolDefinition[];
  expiresAt: number;
}

export class CliRunGrantStore {
  private readonly grants = new Map<string, CliRunGrant>();
  private readonly now: () => number;

  constructor(input: { now?: () => number } = {}) {
    this.now = input.now ?? Date.now;
  }

  issue(input: {
    tradexSessionId: string;
    registry: ToolRegistry;
    ttlMs: number;
    runtime: AgentRuntimeId;
  }): { token: string; expiresAt: number } {
    const token = randomBytes(32).toString("base64url");
    const expiresAt = this.now() + input.ttlMs;
    this.grants.set(hashToken(token), {
      tradexSessionId: input.tradexSessionId,
      tools: input.runtime === "pi"
        ? input.registry.listTools()
        : input.registry.listToolsForExternalRuntime(input.runtime),
      expiresAt,
    });
    return { token, expiresAt };
  }

  resolve(token: string): CliRunGrant | null {
    if (!token) return null;
    const key = hashToken(token);
    const grant = this.grants.get(key);
    if (!grant) return null;
    if (grant.expiresAt <= this.now()) {
      this.grants.delete(key);
      return null;
    }
    return grant;
  }

  revoke(token: string): void {
    if (token) this.grants.delete(hashToken(token));
  }
}

/** Write the per-run `tradex` command and return the environment for the child. */
export async function prepareTradexCli(input: {
  cwd: string;
  url: string;
  token: string;
}): Promise<{ env: NodeJS.ProcessEnv; cleanup: () => Promise<void> }> {
  // Pi sessions can overlap in the same process cwd. Keep each command and
  // token-bearing environment isolated so one run cannot remove another run's
  // executable while it is still active.
  const runtimeDir = path.join(input.cwd, "runtime");
  await mkdir(runtimeDir, { recursive: true, mode: 0o700 });
  const binDir = await mkdtemp(path.join(runtimeDir, "bin-"));
  const scriptPath = path.join(binDir, "tradex-cli.mjs");
  const commandPath = path.join(binDir, "tradex");
  const windowsCommandPath = path.join(binDir, "tradex.cmd");
  await writeFile(scriptPath, CLI_SCRIPT, { encoding: "utf8", mode: 0o700 });
  await writeFile(commandPath, `#!/bin/sh\nexec "$TRADEX_CLI_NODE" "$TRADEX_CLI_SCRIPT" "$@"\n`, {
    encoding: "utf8",
    mode: 0o700,
  });
  await writeFile(windowsCommandPath, `@"%TRADEX_CLI_NODE%" "%TRADEX_CLI_SCRIPT%" %*\r\n`, {
    encoding: "utf8",
    mode: 0o700,
  });
  if (process.platform !== "win32") await chmod(commandPath, 0o700);

  const inheritedPath = process.env.PATH ?? "";
  const env: NodeJS.ProcessEnv = {
    TRADEX_CLI_URL: input.url,
    TRADEX_CLI_TOKEN: input.token,
    TRADEX_CLI_NODE: process.execPath,
    TRADEX_CLI_SCRIPT: scriptPath,
    PATH: `${binDir}${path.delimiter}${inheritedPath}`,
  };
  return {
    env,
    cleanup: () => rm(binDir, { recursive: true, force: true }),
  };
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Plain JavaScript so the command works from both tsx development and builds. */
const CLI_SCRIPT = String.raw`#!/usr/bin/env node
const base = process.env.TRADEX_CLI_URL;
const token = process.env.TRADEX_CLI_TOKEN;

if (!base || !token) {
  console.error("Tradex CLI is only available inside an active Agent Session");
  process.exit(2);
}

const headers = { "content-type": "application/json", authorization: "Bearer " + token };
const argv = process.argv.slice(2);
const command = argv[0] === "tool" ? argv[1] : argv[0];
const rest = argv[0] === "tool" ? argv.slice(2) : argv.slice(1);

function print(value) {
  process.stdout.write(JSON.stringify(value) + "\\n");
}

function usage() {
  print({
    commands: {
      "tool list": "List the tools available in this Agent Session",
      "tool describe <name>": "Show one tool description and JSON schema",
      "tool call <name> --json <object>": "Execute one tool with JSON arguments",
    },
    note: "Use tool list or tool describe before calling an unfamiliar tool.",
  });
}

async function request(method, suffix, body) {
  const response = await fetch(base + suffix, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  let value;
  try { value = JSON.parse(text); } catch { value = { error: text || response.statusText }; }
  if (!response.ok) {
    print({ ok: false, status: response.status, ...value });
    process.exitCode = 1;
    return null;
  }
  return value;
}

try {
  if (!command || command === "help" || command === "--help") {
    usage();
  } else if (command === "list") {
    print(await request("GET", "/manifest"));
  } else if (command === "describe") {
    const name = rest[0];
    if (!name) { usage(); process.exitCode = 2; }
    else {
      const manifest = await request("GET", "/manifest");
      const tool = manifest?.tools?.find((item) => item.name === name);
      if (!tool) { print({ ok: false, error: "Unknown or unauthorized tool: " + name }); process.exitCode = 1; }
      else print(tool);
    }
  } else if (command === "call") {
    const name = rest[0];
    let raw = "{}";
    for (let index = 1; index < rest.length; index += 1) {
      if (rest[index] === "--json" && rest[index + 1] !== undefined) raw = rest[++index];
      else if (rest[index].startsWith("--json=")) raw = rest[index].slice("--json=".length);
      else { print({ ok: false, error: "Unknown argument: " + rest[index] }); process.exit(2); }
    }
    let args;
    try { args = JSON.parse(raw); } catch { print({ ok: false, error: "--json must contain a valid JSON object" }); process.exit(2); }
    if (!args || typeof args !== "object" || Array.isArray(args)) { print({ ok: false, error: "--json must contain a JSON object" }); process.exit(2); }
    const result = await request("POST", "/invoke", { name, args });
    if (result) print({ ok: true, tool: name, ...result });
  } else {
    print({ ok: false, error: "Unknown command: " + command });
    usage();
    process.exitCode = 2;
  }
} catch (error) {
  print({ ok: false, error: error instanceof Error ? error.message : String(error) });
  process.exitCode = 1;
}
`;
