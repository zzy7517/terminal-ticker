/** 探测本机 Claude Code CLI，并维护已知 model/effort 目录。 */
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

/** 检查 CLI 版本和 project purge 能力，生成前端可展示的可用性结果。 */
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

/** 将显式路径或 PATH 中的命令名解析为可执行文件路径。 */
async function resolveExecutable(value: string): Promise<string | null> {
  // 配置值包含路径分隔符时按显式路径处理，否则按 PATH 逐目录查找 Claude。
  // 这里只返回具有执行权限的文件，避免后续探测阶段才暴露“找不到命令”的错误。
  const candidates = value.includes(path.sep)
    ? [path.resolve(value)]
    : (process.env.PATH ?? "").split(path.delimiter).filter(Boolean).map((directory) => path.join(directory, value));
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch { /* try the next PATH entry */ }
  }
  // 没有找到可执行文件时由上层返回不可用状态，并保留用户配置的原始路径。
  return null;
}

/** 在有限时间内运行一次 Claude 探测命令并收集受限输出。 */
function runProbe(executablePath: string, args: string[]): Promise<{ output: string; error: string | null }> {
  // 用独立子进程执行 --version 或 project purge --help 等探测命令。
  // shell:false 防止路径或参数被 shell 重新解释；stdout/stderr 也只保留最后 8KB。
  return new Promise((resolve) => {
    const child = spawn(executablePath, args, { shell: false, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (result: { output: string; error: string | null }) => {
      // error/close/超时可能先后触发，settled 保证探测只结束一次。
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      // 探测命令不能无限期占用后端；超时后终止子进程并返回稳定错误。
      child.kill("SIGTERM");
      finish({ output: "", error: "Claude Code probe timed out" });
    }, 3_000);
    timer.unref();
    child.stdout.on("data", (chunk: Buffer) => { stdout = (stdout + chunk.toString("utf8")).slice(-32_768); });
    child.stderr.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString("utf8")).slice(-32_768); });
    child.once("error", (error) => finish({ output: "", error: error.message }));
    child.once("close", (code) => finish(code === 0
      ? { output: stdout.trim() || stderr.trim(), error: null }
      : { output: "", error: stderr.trim() || `Claude Code exited with code ${code ?? "unknown"}` }));
  });
}
