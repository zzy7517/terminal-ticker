/** 以 headless stream-json 模式运行 Cursor Agent CLI，并输出统一 Runtime 事件。 */
import { createInterface } from "node:readline";
import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import type { ToolRegistry } from "../../tools/registry.js";
import { CliRunGrantStore, prepareTradexCli } from "../cli-tools.js";
import { CURSOR_CLI_CAPABILITIES } from "../capabilities.js";
import type { ActiveRuntimeRun, RuntimeEvent, RuntimeRunResult } from "../types.js";
import { classifyCursorError, cursorLineType, parseCursorLine } from "./protocol.js";
import { windowsTaskkillArgs } from "../claude-code/runtime.js";

export { classifyCursorError, parseCursorLine } from "./protocol.js";

const CURSOR_WRITABLE_ITERABLE_CLOSED = "RetriableError: WritableIterable is closed";

export interface CursorArgsInput {
  prompt: string;
  instructions: string;
  workspace: string;
  nativeSessionId?: string;
  model?: string | null;
  sandbox?: "enabled" | "disabled" | null;
}

/** 生成不经过 shell 的 Cursor headless argv。instructions 会 prepend 到 prompt。 */
export function buildCursorArgs(input: CursorArgsInput): string[] {
  const args = [
    "-p",
    "--force",
    "--trust",
    "--output-format", "stream-json",
    "--stream-partial-output",
    "--workspace", input.workspace,
  ];
  if (input.nativeSessionId) args.push("--resume", input.nativeSessionId);
  if (input.model) args.push("--model", input.model);
  if (input.sandbox === "enabled" || input.sandbox === "disabled") {
    args.push("--sandbox", input.sandbox);
  }
  args.push(composeCursorPrompt(input.instructions, input.prompt));
  return args;
}

export function composeCursorPrompt(instructions: string, prompt: string): string {
  const trimmedInstructions = instructions.trim();
  const trimmedPrompt = prompt.trim();
  if (!trimmedInstructions) return trimmedPrompt || prompt;
  if (!trimmedPrompt) return trimmedInstructions;
  return `${trimmedInstructions}\n\n---\n\n${trimmedPrompt}`;
}

export interface CursorCliRuntimeOptions {
  executablePath?: string;
  cliUrl: string;
  grants: CliRunGrantStore;
  grantTtlMs?: number;
  runTimeoutMs?: number;
  inactivityTimeoutMs?: number;
}

export interface CursorRunInput {
  tradexSessionId: string;
  cwd: string;
  prompt: string;
  instructions: string;
  registry: ToolRegistry;
  nativeSessionId?: string;
  model?: string | null;
}

export class CursorCliRuntime {
  readonly id = "cursor" as const;
  readonly capabilities = CURSOR_CLI_CAPABILITIES;
  private readonly executablePath: string;
  private readonly cliUrl: string;
  private readonly grants: CliRunGrantStore;
  private readonly grantTtlMs: number;
  private readonly runTimeoutMs: number;
  private readonly inactivityTimeoutMs: number;

  constructor(options: CursorCliRuntimeOptions) {
    this.executablePath = options.executablePath ?? "cursor-agent";
    this.cliUrl = options.cliUrl;
    this.grants = options.grants;
    this.grantTtlMs = options.grantTtlMs ?? 60 * 60_000;
    this.runTimeoutMs = options.runTimeoutMs ?? 30 * 60_000;
    this.inactivityTimeoutMs = options.inactivityTimeoutMs ?? 5 * 60_000;
  }

  /** 创建本轮 CLI grant、准备 session `tradex` command、启动 Cursor CLI。 */
  async start(input: CursorRunInput): Promise<ActiveRuntimeRun> {
    const issued = this.grants.issue({
      tradexSessionId: input.tradexSessionId,
      registry: input.registry,
      ttlMs: this.grantTtlMs,
      runtime: "cursor",
    });
    let cli: Awaited<ReturnType<typeof prepareTradexCli>> | null = null;
    let handedOff = false;
    try {
      cli = await prepareTradexCli({ cwd: input.cwd, url: this.cliUrl, token: issued.token });
      let nativeSessionId = input.nativeSessionId;
      if (!nativeSessionId) {
        nativeSessionId = await createCursorChat(this.executablePath);
      }

      const args = buildCursorArgs({
        prompt: input.prompt,
        instructions: input.instructions,
        workspace: input.cwd,
        nativeSessionId,
        model: input.model,
        sandbox: "disabled",
      });
      const child = spawn(this.executablePath, args, {
        cwd: input.cwd,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        detached: process.platform !== "win32",
        env: { ...sanitizedCursorEnv(process.env), ...cli.env },
      });
      const run = new CursorActiveRun({
        child,
        assignedNativeSessionId: nativeSessionId,
        runTimeoutMs: this.runTimeoutMs,
        inactivityTimeoutMs: this.inactivityTimeoutMs,
        revoke: () => this.grants.revoke(issued.token),
        cleanup: cli.cleanup,
      });
      handedOff = true;
      return run;
    } finally {
      if (!handedOff) {
        this.grants.revoke(issued.token);
        await cli?.cleanup();
      }
    }
  }
}

class CursorActiveRun implements ActiveRuntimeRun {
  readonly runtime = "cursor" as const;
  readonly capabilities = CURSOR_CLI_CAPABILITIES;
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
  private terminalResultReceived = false;
  private assistantBuffer = "";

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
      let output = "";
      let nativeSessionId = input.assignedNativeSessionId;
      let resultError: string | null = null;
      let resultErrorCode: string | null = null;
      let stderr = "";
      let inactivityTimer: NodeJS.Timeout;
      const stopFor = (code: "run_timeout" | "inactivity_timeout") => {
        if (this.settled || this.terminalResultReceived) return;
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
        if (this.terminalResultReceived) return;
        resetInactivityTimer();
        for (const event of parseCursorLine(line)) {
          const projected = this.projectEvent(event);
          if (!projected) continue;
          if (projected.type === "run-start" && projected.nativeSessionId) {
            nativeSessionId = projected.nativeSessionId;
          }
          if (projected.type === "run-end") {
            // Once the caller has aborted or timed out the run, a result flushed
            // during process shutdown is too late to replace that outcome.
            if (this.terminationCode) continue;
            this.terminalResultReceived = true;
            clearTimeout(runTimer);
            clearTimeout(inactivityTimer);
            nativeSessionId = projected.nativeSessionId ?? nativeSessionId;
            output = projected.result || output;
            if (projected.status === "error") {
              resultError = projected.result || "Cursor CLI run failed";
              resultErrorCode = classifyCursorError(projected.result);
            }
            // Cursor documents result as the terminal event. Stop a worker that
            // remains alive after emitting it; its later exit code is cleanup,
            // not a new protocol outcome.
            this.stopChild();
          }
          if (projected.type === "runtime-error") {
            resultError = projected.message;
            resultErrorCode = projected.code;
          }
          if (projected.type === "message-update") output = this.assistantBuffer;
          this.emit(projected);
        }
        // retry/connection 噪音不转成 RuntimeEvent，但仍刷新超时计时器。
        void cursorLineType(line);
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
        // Cursor can finish useful output, then fail while tearing down its stream.
        // Accept only that exact failure; every other missing terminal result stays an error.
        const completedWithPartialOutput = !this.terminalResultReceived
          && !this.terminationCode
          && !resultError
          && code === 1
          && signal === null
          && this.assistantBuffer.trim().length > 0
          && stderr.trim() === CURSOR_WRITABLE_ITERABLE_CLOSED;
        if (completedWithPartialOutput) {
          output = this.assistantBuffer;
          this.emit({
            type: "run-end",
            ...(nativeSessionId ? { nativeSessionId } : {}),
            result: output,
            status: "completed",
          });
        }
        if (this.terminationCode && !this.terminalResultReceived) {
          resultErrorCode = this.terminationCode;
          resultError ??= this.terminationCode === "aborted"
            ? "Cursor CLI run was aborted"
            : this.terminationCode === "run_timeout"
              ? "Cursor CLI run exceeded its time limit"
              : "Cursor CLI run became inactive and was stopped";
        }
        if (!this.terminalResultReceived && !completedWithPartialOutput && !resultError && code !== 0) {
          resultError = `Cursor CLI exited with code ${code ?? "unknown"}${signal ? ` (${signal})` : ""}${stderr.trim() ? `: ${stderr.trim()}` : ""}`;
          resultErrorCode = this.terminationCode ?? classifyCursorError(stderr);
        }
        if (!this.terminalResultReceived && !completedWithPartialOutput && !resultError) {
          resultError = "Cursor CLI stream ended without terminal result";
          resultErrorCode = "missing_terminal_result";
        }
        if (!this.terminalResultReceived && !completedWithPartialOutput) {
          this.emit({
            type: "run-end",
            ...(nativeSessionId ? { nativeSessionId } : {}),
            result: resultError ?? "",
            status: this.terminationCode === "aborted" ? "aborted" : "error",
          });
        }
        void this.delivery.then(() => {
          if (this.listenerError) {
            resultError = this.listenerError.message;
            resultErrorCode = "runtime_listener_failed";
          }
          resolve({
            output: resultError ? "" : output || this.assistantBuffer,
            nativeSessionId,
            error: resultError,
            errorCode: resultErrorCode,
          });
        });
      });
    });
  }

  subscribe(listener: (event: RuntimeEvent, signal: AbortSignal) => void | Promise<void>): () => void {
    this.listeners.add(listener);
    if (!this.hasSubscribed) {
      this.hasSubscribed = true;
      for (const event of this.pendingEvents.splice(0)) this.deliver(event, listener);
    }
    return () => this.listeners.delete(listener);
  }

  abort(): void {
    if (this.settled || this.terminalResultReceived || !this.child.pid) return;
    this.abortController.abort();
    this.terminationCode = "aborted";
    this.stopChild();
  }

  /** protocol.ts 已过滤重复 flush；这里只顺序累计真实 partial delta。 */
  private projectEvent(event: RuntimeEvent): RuntimeEvent | null {
    if (event.type !== "message-update") return event;
    const delta = event.delta;
    if (!delta) return null;
    this.assistantBuffer += delta;
    return {
      ...event,
      message: { ...event.message, content: [{ type: "text", text: this.assistantBuffer }] },
    };
  }

  private stopChild(): void {
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

  private deliver(event: RuntimeEvent, listener: (event: RuntimeEvent, signal: AbortSignal) => void | Promise<void>): void {
    this.delivery = this.delivery.then(() => listener(event, this.abortController.signal)).catch((error) => {
      this.listenerError ??= error instanceof Error ? error : new Error(String(error));
    });
  }
}

function sanitizedCursorEnv(parent: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = { ...parent };
  for (const key of Object.keys(env)) {
    if (/^TRADEX_CLI_TOKEN$/i.test(key)) delete env[key];
  }
  return env;
}

/** 预创建空 chat，拿到可 resume 的 native session id。 */
export function createCursorChat(executablePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(executablePath, ["create-chat"], {
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error("Cursor create-chat timed out"));
    }, 10_000);
    timer.unref();
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString("utf8")).slice(-8_192); });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      const id = stdout.trim().split(/\s+/).find((token) => /^[0-9a-f-]{36}$/i.test(token));
      if (code === 0 && id) resolve(id);
      else reject(new Error(`Cursor create-chat failed${stderr.trim() ? `: ${stderr.trim()}` : ""}`));
    });
  });
}

/** 将显式 allowlist 中的只读工具标记为可暴露给 Cursor 的工具。 */
const CURSOR_READ_TOOLS = new Set([
  "browser_open_page", "browser_screenshot", "browser_status",
  "check_trade_status", "get_candles", "get_dealer_levels", "get_economic_calendar",
  "get_exchange_fills", "get_exchange_orders", "get_exchange_positions", "get_exposure_breakdown",
  "get_gamma_regime", "get_gex_by_strike", "get_gex_snapshot", "get_hedge_impulse", "get_jin10_quote",
  "get_pressure_cloud", "get_quote", "get_recent_news",
  "get_trade_history", "get_trade_review_context", "list_instruments", "list_open_trades",
  "refresh_news", "web_fetch", "web_search",
]);

export function exposeCursorReadTools(registry: ToolRegistry): ToolRegistry {
  for (const tool of registry.listTools()) {
    if (!CURSOR_READ_TOOLS.has(tool.name)) continue;
    const existing = tool.policy;
    const exposure = new Set(existing?.runtimeExposure ?? ["pi"]);
    exposure.add("cursor");
    registry.setPolicy(tool.name, {
      access: existing?.access ?? "read",
      domain: existing?.domain ?? inferDomain(tool.name),
      runtimeExposure: [...exposure] as Array<"pi" | "claude-code" | "cursor">,
    });
  }
  return registry;
}

function inferDomain(name: string): "market" | "news" | "browser" | "trading" | "other" {
  if (name.startsWith("browser_")) return "browser";
  if (name.includes("news") || name.includes("jin10") || name.includes("economic")) return "news";
  if (name.includes("trade") || name.includes("exchange") || name.includes("position")) return "trading";
  if (name.includes("quote") || name.includes("candle") || name.includes("gex") || name.includes("gamma") || name.includes("options") || name.includes("pressure") || name.includes("exposure") || name.includes("hedge")) {
    return "market";
  }
  return "other";
}
