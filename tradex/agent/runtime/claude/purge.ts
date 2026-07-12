/** 在删除 Tradex 投影前，清理 Claude 原生 project 状态。 */
import { spawn } from "node:child_process";

/** 调用 Claude 官方 purge 命令，项目不存在时按幂等成功处理。 */
export async function purgeClaudeProject(executablePath: string, cwd: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(executablePath, ["project", "purge", cwd, "--yes"], {
      shell: false,
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString("utf8")).slice(-8_192); });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0 || /(?:no project state|project .* not found|nothing to purge)/i.test(stderr)) resolve();
      else reject(new Error(`Claude project purge failed with code ${code ?? "unknown"}${stderr.trim() ? `: ${stderr.trim()}` : ""}`));
    });
  });
}
