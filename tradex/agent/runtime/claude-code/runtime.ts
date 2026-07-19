/** 以 headless stream-json 模式运行 Claude，并输出统一 Runtime 事件。 */
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import type { ToolRegistry } from "../../tools/registry.js";
import type { McpRunGrantStore } from "../../../mcp/server/grants.js";
import { CLAUDE_CODE_CAPABILITIES } from "../capabilities.js";
import type { ActiveRuntimeRun, RuntimeEvent, RuntimeRunResult } from "../types.js";
import { claudeLineType, classifyClaudeError, parseClaudeLine } from "./protocol.js";

export { classifyClaudeError, parseClaudeLine } from "./protocol.js";

export interface ClaudeArgsInput {
  prompt: string;
  instructions: string;
  mcpConfigPath: string;
  allowedMcpTools: string[];
  nativeSessionId?: string;
  assignedNativeSessionId?: string;
  model?: string | null;
  effort?: string | null;
}

/** 生成不经过 shell 的 Claude headless argv，并按需添加 resume/model/effort。 */
export function buildClaudeArgs(input: ClaudeArgsInput): string[] {
  // 所有参数都以 argv 传入，禁止拼接 shell 字符串，避免 prompt 或路径产生注入问题。
  const mcpTools = input.allowedMcpTools.map((name) => `mcp__tradex__${name}`);
  const nativeTools = ["Read", "Bash"];
  const tools = [...nativeTools, ...mcpTools];
  const allowedTools = [...nativeTools, ...mcpTools];
  // Tradex 显式提供本轮配置，不继承可能注册 hooks 的用户或项目 settings。
  const args = [
    "-p",
    "--verbose",
    "--output-format", "stream-json",
    "--include-partial-messages",
    "--permission-mode", "dontAsk",
    "--setting-sources", "",
    "--strict-mcp-config",
    "--mcp-config", input.mcpConfigPath,
    "--system-prompt", input.instructions,
    "--tools", tools.join(","),
    "--allowedTools", allowedTools.join(","),
  ];
  if (input.nativeSessionId) args.push("--resume", input.nativeSessionId);
  else if (input.assignedNativeSessionId) args.push("--session-id", input.assignedNativeSessionId);
  if (input.model) args.push("--model", input.model);
  if (input.effort) args.push("--effort", input.effort);
  args.push("--", input.prompt);
  return args;
}

export interface ClaudeCodeRuntimeOptions {
  executablePath?: string;
  mcpUrl: string;
  grants: McpRunGrantStore;
  grantTtlMs?: number;
  runTimeoutMs?: number;
  inactivityTimeoutMs?: number;
}

export interface ClaudeRunInput {
  tradexSessionId: string;
  cwd: string;
  prompt: string;
  instructions: string;
  registry: ToolRegistry;
  nativeSessionId?: string;
  model?: string | null;
  effort?: string | null;
}

export class ClaudeCodeRuntime {
  readonly id = "claude-code" as const;
  readonly capabilities = CLAUDE_CODE_CAPABILITIES;
  private readonly executablePath: string;
  private readonly mcpUrl: string;
  private readonly grants: McpRunGrantStore;
  private readonly grantTtlMs: number;
  private readonly runTimeoutMs: number;
  private readonly inactivityTimeoutMs: number;

  /** 保存进程、MCP 授权和超时策略配置。 */
  constructor(options: ClaudeCodeRuntimeOptions) {
    this.executablePath = options.executablePath ?? "claude";
    this.mcpUrl = options.mcpUrl;
    this.grants = options.grants;
    this.grantTtlMs = options.grantTtlMs ?? 60 * 60_000;
    this.runTimeoutMs = options.runTimeoutMs ?? 30 * 60_000;
    this.inactivityTimeoutMs = options.inactivityTimeoutMs ?? 5 * 60_000;
  }

  /** 创建本轮 MCP grant、启动 Claude 子进程并返回活动运行句柄。 */
  async start(input: ClaudeRunInput): Promise<ActiveRuntimeRun> {
    // 每次 run 使用独立 MCP 配置和 token；即使是 resume，也不复用上一轮授权。
    const runtimeDir = path.join(input.cwd, "runtime");
    await mkdir(runtimeDir, { recursive: true, mode: 0o700 });
    const issued = this.grants.issue({
      tradexSessionId: input.tradexSessionId,
      registry: input.registry,
      ttlMs: this.grantTtlMs,
    });
    const mcpConfigPath = path.join(runtimeDir, `mcp-${randomUUID()}.json`);
    let handedOff = false;
    try {
      await writeFile(mcpConfigPath, `${JSON.stringify({
        mcpServers: {
          tradex: {
            type: "http",
            url: this.mcpUrl,
            headers: { Authorization: `Bearer ${issued.token}` },
          },
        },
      })}\n`, { encoding: "utf8", mode: 0o600 });

      const assignedNativeSessionId = input.nativeSessionId ? undefined : randomUUID();
      // 必须与 McpRunGrantStore.issue 一致：允许协作写，禁止交易写。
      const allowedMcpTools = input.registry.listToolsForClaudeMcp().map((tool) => tool.name);
      const args = buildClaudeArgs({
        prompt: input.prompt,
        instructions: input.instructions,
        mcpConfigPath,
        allowedMcpTools,
        nativeSessionId: input.nativeSessionId,
        assignedNativeSessionId,
        model: input.model,
        effort: input.effort,
      });
      const child = spawn(this.executablePath, args, {
        cwd: input.cwd,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        detached: process.platform !== "win32",
        env: sanitizedClaudeEnv(process.env),
      });
      const run = new ClaudeActiveRun({
        child,
        assignedNativeSessionId,
        runTimeoutMs: this.runTimeoutMs,
        inactivityTimeoutMs: this.inactivityTimeoutMs,
        revoke: () => this.grants.revoke(issued.token),
        cleanup: () => rm(mcpConfigPath, { force: true }),
      });
      handedOff = true;
      return run;
    } finally {
      // issue 成功后、ActiveRun 接管之前若失败，必须立刻撤销 grant 并清掉含 Bearer 的临时配置。
      if (!handedOff) {
        this.grants.revoke(issued.token);
        await rm(mcpConfigPath, { force: true });
      }
    }
  }
}

class ClaudeActiveRun implements ActiveRuntimeRun {
  readonly runtime = "claude-code" as const;
  readonly capabilities = CLAUDE_CODE_CAPABILITIES;
  readonly nativeSessionId?: string;
  readonly result: Promise<RuntimeRunResult>;
  private readonly listeners = new Set<(event: RuntimeEvent, signal: AbortSignal) => void | Promise<void>>();
  private readonly abortController = new AbortController();
  private readonly child: ChildProcessByStdio<null, Readable, Readable>;
  private readonly pendingEvents: RuntimeEvent[] = [];
  private hasSubscribed = false;
  private settled = false;
  private delivery = Promise.resolve();
  private listenerError: Error | null = null;
  private terminationCode: "aborted" | "run_timeout" | "inactivity_timeout" | null = null;

  constructor(input: {
    child: ChildProcessByStdio<null, Readable, Readable>;
    assignedNativeSessionId?: string;
    runTimeoutMs: number;
    inactivityTimeoutMs: number;
    revoke: () => void;
    cleanup: () => Promise<void>;
  }) {
    this.child = input.child;
    this.nativeSessionId = input.assignedNativeSessionId;
    this.result = new Promise((resolve) => {
      // stdout 只解析协议事件，stderr 仅保留最后一段用于错误分类，避免泄露完整日志。
      let output = "";
      let nativeSessionId = input.assignedNativeSessionId;
      let resultError: string | null = null;
      let resultErrorCode: string | null = null;
      let stderr = "";
      let sawPartialText = false;
      let sawRunEnd = false;
      let inactivityTimer: NodeJS.Timeout;
      const stopFor = (code: "run_timeout" | "inactivity_timeout") => {
        if (this.settled) return;
        this.terminationCode = code;
        this.stopChild();
      };
      const resetInactivityTimer = () => {
        clearTimeout(inactivityTimer);
        inactivityTimer = setTimeout(() => stopFor("inactivity_timeout"), input.inactivityTimeoutMs);
        inactivityTimer.unref();
      };
      const runTimer = setTimeout(() => stopFor("run_timeout"), input.runTimeoutMs);
      runTimer.unref();
      resetInactivityTimer();
      const lines = createInterface({ input: input.child.stdout, crlfDelay: Infinity });
      lines.on("line", (line) => {
        resetInactivityTimer();
        const lineType = claudeLineType(line);
        for (const event of parseClaudeLine(line)) {
          if (lineType === "stream_event" && event.type === "message-update") sawPartialText = true;
          if (lineType === "assistant" && sawPartialText && event.type === "message-update") continue;
          if (event.type === "run-start" && event.nativeSessionId) nativeSessionId = event.nativeSessionId;
          if (event.type === "run-end") {
            sawRunEnd = true;
            nativeSessionId = event.nativeSessionId ?? nativeSessionId;
            output = event.result || output;
            if (event.status === "error") {
              resultError = event.result || "Claude Code run failed";
              resultErrorCode = classifyClaudeError(event.result);
            }
          }
          if (event.type === "runtime-error") {
            resultError = event.message;
            resultErrorCode = event.code;
          }
          if (event.type === "message-update") output += event.delta;
          this.emit(event);
        }
      });
      input.child.stderr.on("data", (chunk: Buffer) => {
        stderr = (stderr + chunk.toString("utf8")).slice(-16_384);
      });
      input.child.once("error", (error) => {
        resultError = error.message;
        resultErrorCode = (error as NodeJS.ErrnoException).code === "ENOENT" ? "executable_missing" : "process_spawn_failed";
      });
      input.child.once("close", (code, signal) => {
        this.settled = true;
        clearTimeout(runTimer);
        clearTimeout(inactivityTimer);
        input.revoke();
        void input.cleanup();
        if (this.terminationCode) {
          resultErrorCode = this.terminationCode;
          resultError ??= this.terminationCode === "aborted"
            ? "Claude Code run was aborted"
            : this.terminationCode === "run_timeout"
              ? "Claude Code run exceeded its time limit"
              : "Claude Code run became inactive and was stopped";
        }
        if (!resultError && code !== 0) {
          resultError = `Claude Code exited with code ${code ?? "unknown"}${signal ? ` (${signal})` : ""}${stderr.trim() ? `: ${stderr.trim()}` : ""}`;
          resultErrorCode = this.terminationCode ?? classifyClaudeError(stderr);
        }
        if (!sawRunEnd) {
          this.emit({
            type: "run-end",
            ...(nativeSessionId ? { nativeSessionId } : {}),
            result: output,
            status: this.terminationCode === "aborted" ? "aborted" : resultError ? "error" : "completed",
          });
        }
        void this.delivery.then(() => {
          if (this.listenerError) {
            resultError = this.listenerError.message;
            resultErrorCode = "runtime_listener_failed";
          }
          resolve({ output, nativeSessionId, error: resultError, errorCode: resultErrorCode });
        });
      });
    });
  }

  /** 订阅规范化事件，并先回放订阅前已经收到的事件。 */
  subscribe(listener: (event: RuntimeEvent, signal: AbortSignal) => void | Promise<void>): () => void {
    this.listeners.add(listener);
    if (!this.hasSubscribed) {
      this.hasSubscribed = true;
      for (const event of this.pendingEvents.splice(0)) this.deliver(event, listener);
    }
    return () => this.listeners.delete(listener);
  }

  /** 终止 Claude 进程组，并让最终结果标记为 aborted。 */
  abort(): void {
    if (this.settled || !this.child.pid) return;
    this.abortController.abort();
    this.terminationCode = "aborted";
    this.stopChild();
  }

  private stopChild(): void {
    // Claude 可能继续派生 MCP/工具子进程，因此 POSIX 需要杀整个 process group。
    if (this.settled || !this.child.pid) return;
    if (process.platform === "win32") {
      this.stopWindowsProcessTree(false);
      const timer = setTimeout(() => {
        if (!this.settled) this.stopWindowsProcessTree(true);
      }, 5_000);
      timer.unref();
    } else {
      try { process.kill(-this.child.pid, "SIGTERM"); } catch { this.child.kill("SIGTERM"); }
      const timer = setTimeout(() => {
        if (this.settled || !this.child.pid) return;
        try { process.kill(-this.child.pid, "SIGKILL"); } catch { this.child.kill("SIGKILL"); }
      }, 5_000);
      timer.unref();
    }
  }

  private stopWindowsProcessTree(force: boolean): void {
    if (!this.child.pid) return;
    const killer = spawn("taskkill", windowsTaskkillArgs(this.child.pid, force), {
      shell: false,
      stdio: "ignore",
      windowsHide: true,
    });
    killer.once("error", () => this.child.kill(force ? "SIGKILL" : "SIGTERM"));
  }

  private emit(event: RuntimeEvent): void {
    if (!this.hasSubscribed) {
      this.pendingEvents.push(event);
      return;
    }
    for (const listener of this.listeners) this.deliver(event, listener);
  }

  // 串行调用异步 listener，并记录首个监听失败。
  private deliver(event: RuntimeEvent, listener: (event: RuntimeEvent, signal: AbortSignal) => void | Promise<void>): void {
    this.delivery = this.delivery.then(() => listener(event, this.abortController.signal)).catch((error) => {
      this.listenerError ??= error instanceof Error ? error : new Error(String(error));
    });
  }
}

/** 生成 Windows taskkill 的进程树终止参数。 */
export function windowsTaskkillArgs(pid: number, force: boolean): string[] {
  return ["/PID", String(pid), "/T", ...(force ? ["/F"] : [])];
}

function sanitizedClaudeEnv(parent: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = { ...parent };
  for (const key of Object.keys(env)) {
    if (/^TRADEX_MCP_TOKEN$/i.test(key)) delete env[key];
  }
  return env;
}

/** 在删除 Tradex 投影前，清理 Claude 原生 project 状态。项目不存在时按幂等成功处理。 */
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

/** 定义 Claude Code 首期可以使用的显式只读 Tradex Tool 集合。 */
const CLAUDE_READ_TOOLS = new Set([
  "browser_open_page", "browser_screenshot", "browser_status",
  "check_trade_status", "get_candles", "get_dealer_levels", "get_economic_calendar",
  "get_exchange_fills", "get_exchange_orders", "get_exchange_positions", "get_exposure_breakdown",
  "get_gamma_regime", "get_gex_by_strike", "get_gex_snapshot", "get_hedge_impulse", "get_jin10_quote",
  "get_options_flow", "get_pressure_cloud", "get_quote", "get_recent_news",
  "get_trade_history", "get_trade_review_context", "list_instruments", "list_open_trades",
  "refresh_news", "web_fetch", "web_search",
]);

/** 将显式 allowlist 中的只读工具标记为可暴露给 Claude 的工具。 */
export function exposeClaudeReadTools(registry: ToolRegistry): ToolRegistry {
  // Claude 首期只拿到显式 allowlist；不能根据工具名前缀推断读写权限。
  for (const tool of registry.listTools()) {
    if (!CLAUDE_READ_TOOLS.has(tool.name)) continue;
    registry.setPolicy(tool.name, {
      access: "read",
      domain: inferDomain(tool.name),
      runtimeExposure: ["pi", "claude-code"],
    });
  }
  return registry;
}

/** 根据工具名映射展示和审计所需的业务域。 */
function inferDomain(name: string): "market" | "news" | "browser" | "trading" | "other" {
  if (name.startsWith("browser_")) return "browser";
  if (name.includes("news") || name.includes("jin10") || name.includes("economic")) return "news";
  if (name.includes("trade") || name.includes("exchange") || name.includes("position")) return "trading";
  if (name.includes("quote") || name.includes("candle") || name.includes("gex") || name.includes("gamma") || name.includes("options") || name.includes("pressure") || name.includes("exposure") || name.includes("hedge")) return "market";
  return "other";
}
