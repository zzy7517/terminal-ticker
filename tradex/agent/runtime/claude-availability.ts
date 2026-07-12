import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";

export interface ClaudeCodeAvailability {
  id: "claude-code";
  available: boolean;
  executablePath: string;
  version: string | null;
  error: string | null;
}

export async function detectClaudeCode(configuredPath = process.env.TRADEX_CLAUDE_PATH?.trim() || "claude"): Promise<ClaudeCodeAvailability> {
  const executablePath = await resolveExecutable(configuredPath) ?? configuredPath;
  const version = await runProbe(executablePath, ["--version"]);
  if (version.error) {
    return { id: "claude-code", available: false, executablePath, version: null, error: version.error };
  }
  const purge = await runProbe(executablePath, ["project", "purge", "--help"]);
  if (purge.error) {
    return {
      id: "claude-code",
      available: false,
      executablePath,
      version: version.output || null,
      error: `Claude Code does not support project purge: ${purge.error}`,
    };
  }
  return { id: "claude-code", available: true, executablePath, version: version.output || null, error: null };
}

async function resolveExecutable(value: string): Promise<string | null> {
  const candidates = value.includes(path.sep)
    ? [path.resolve(value)]
    : (process.env.PATH ?? "").split(path.delimiter).filter(Boolean).map((directory) => path.join(directory, value));
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch { /* try the next PATH entry */ }
  }
  return null;
}

function runProbe(executablePath: string, args: string[]): Promise<{ output: string; error: string | null }> {
  return new Promise((resolve) => {
    const child = spawn(executablePath, args, { shell: false, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (result: { output: string; error: string | null }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      finish({ output: "", error: "Claude Code probe timed out" });
    }, 3_000);
    timer.unref();
    child.stdout.on("data", (chunk: Buffer) => { stdout = (stdout + chunk.toString("utf8")).slice(-8_192); });
    child.stderr.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString("utf8")).slice(-8_192); });
    child.once("error", (error) => finish({ output: "", error: error.message }));
    child.once("close", (code) => finish(code === 0
      ? { output: stdout.trim() || stderr.trim(), error: null }
      : { output: "", error: stderr.trim() || `Claude Code exited with code ${code ?? "unknown"}` }));
  });
}
