/** 探测本机 Cursor Agent CLI（agent / cursor-agent）。 */
import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import os from "node:os";

export interface CursorCliAvailability {
  id: "cursor";
  available: boolean;
  executablePath: string;
  version: string | null;
  error: string | null;
}

/** 检查 CLI 版本与 create-chat 能力，生成前端可展示的可用性结果。 */
export async function detectCursorCli(
  configuredPath = process.env.TRADEX_CURSOR_PATH?.trim() || "",
): Promise<CursorCliAvailability> {
  const candidates = configuredPath
    ? [configuredPath]
    : defaultCursorExecutableCandidates();
  let lastError: string | null = null;
  for (const candidate of candidates) {
    const executablePath = await resolveExecutable(candidate) ?? candidate;
    const version = await runProbe(executablePath, ["--version"]);
    if (version.error) {
      lastError = version.error;
      continue;
    }
    const createChat = await runProbe(executablePath, ["create-chat", "--help"]);
    if (createChat.error && !/Usage:|create-chat/i.test(createChat.output)) {
      return {
        id: "cursor",
        available: false,
        executablePath,
        version: version.output || null,
        error: `Cursor CLI does not support create-chat: ${createChat.error}`,
      };
    }
    return {
      id: "cursor",
      available: true,
      executablePath,
      version: version.output.split("\n")[0]?.trim() || null,
      error: null,
    };
  }
  const fallback = candidates[0] ?? "cursor-agent";
  return {
    id: "cursor",
    available: false,
    executablePath: fallback,
    version: null,
    error: lastError ?? "Cursor Agent CLI not found",
  };
}

/** 优先解析真实 cursor-agent，避开可能被 alias 污染的 `agent`。 */
function defaultCursorExecutableCandidates(): string[] {
  return [
    "cursor-agent",
    path.join(os.homedir(), ".local", "bin", "cursor-agent"),
    "agent",
  ];
}

/** 将显式路径或 PATH 中的命令名解析为可执行文件路径。 */
async function resolveExecutable(value: string): Promise<string | null> {
  const candidates = value.includes(path.sep)
    ? [path.resolve(value)]
    : (process.env.PATH ?? "").split(path.delimiter).filter(Boolean).map((directory) => path.join(directory, value));
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch { /* try next */ }
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
      finish({ output: "", error: "Cursor CLI probe timed out" });
    }, 5_000);
    timer.unref();
    child.stdout.on("data", (chunk: Buffer) => { stdout = (stdout + chunk.toString("utf8")).slice(-32_768); });
    child.stderr.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString("utf8")).slice(-32_768); });
    child.once("error", (error) => finish({ output: "", error: error.message }));
    child.once("close", (code) => finish(code === 0
      ? { output: stdout.trim() || stderr.trim(), error: null }
      : { output: stdout.trim() || stderr.trim(), error: stderr.trim() || `Cursor CLI exited with code ${code ?? "unknown"}` }));
  });
}
