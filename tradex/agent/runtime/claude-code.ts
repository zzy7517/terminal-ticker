import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import type { ToolRegistry } from "../tools/registry.js";
import type { McpRunGrantStore } from "../../mcp/server/grants.js";
import type { ActiveRuntimeRun, RuntimeEvent, RuntimeRunResult } from "./types.js";

export const CLAUDE_CODE_CAPABILITIES = {
  streaming: true,
  abort: true,
  steer: false,
  resume: true,
  forkFromMessage: false,
  cloneFromMessage: false,
  imageInput: true,
} as const;

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

export function buildClaudeArgs(input: ClaudeArgsInput): string[] {
  const mcpTools = input.allowedMcpTools.map((name) => `mcp__tradex__${name}`);
  const tools = mcpTools;
  const args = [
    "-p",
    "--verbose",
    "--output-format", "stream-json",
    "--include-partial-messages",
    "--permission-mode", "dontAsk",
    "--strict-mcp-config",
    "--mcp-config", input.mcpConfigPath,
    "--append-system-prompt", input.instructions,
    "--tools", tools.join(","),
    "--allowedTools", mcpTools.join(","),
  ];
  if (input.nativeSessionId) args.push("--resume", input.nativeSessionId);
  else if (input.assignedNativeSessionId) args.push("--session-id", input.assignedNativeSessionId);
  if (input.model) args.push("--model", input.model);
  if (input.effort) args.push("--effort", input.effort);
  args.push(input.prompt);
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

  constructor(options: ClaudeCodeRuntimeOptions) {
    this.executablePath = options.executablePath ?? "claude";
    this.mcpUrl = options.mcpUrl;
    this.grants = options.grants;
    this.grantTtlMs = options.grantTtlMs ?? 60 * 60_000;
    this.runTimeoutMs = options.runTimeoutMs ?? 30 * 60_000;
    this.inactivityTimeoutMs = options.inactivityTimeoutMs ?? 5 * 60_000;
  }

  async start(input: ClaudeRunInput): Promise<ActiveRuntimeRun> {
    const runtimeDir = path.join(input.cwd, "runtime");
    await mkdir(runtimeDir, { recursive: true, mode: 0o700 });
    const issued = this.grants.issue({
      tradexSessionId: input.tradexSessionId,
      registry: input.registry,
      ttlMs: this.grantTtlMs,
    });
    const mcpConfigPath = path.join(runtimeDir, `mcp-${randomUUID()}.json`);
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
    const allowedMcpTools = input.registry.listToolsForRuntime("claude-code", "read").map((tool) => tool.name);
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
    return new ClaudeActiveRun({
      child,
      assignedNativeSessionId,
      runTimeoutMs: this.runTimeoutMs,
      inactivityTimeoutMs: this.inactivityTimeoutMs,
      revoke: () => this.grants.revoke(issued.token),
      cleanup: () => rm(mcpConfigPath, { force: true }),
    });
  }
}

class ClaudeActiveRun implements ActiveRuntimeRun {
  readonly runtime = "claude-code" as const;
  readonly capabilities = CLAUDE_CODE_CAPABILITIES;
  readonly nativeSessionId?: string;
  readonly result: Promise<RuntimeRunResult>;
  private readonly listeners = new Set<(event: RuntimeEvent) => void>();
  private readonly child: ChildProcessByStdio<null, Readable, Readable>;
  private readonly pendingEvents: RuntimeEvent[] = [];
  private hasSubscribed = false;
  private settled = false;
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
      let output = "";
      let nativeSessionId = input.assignedNativeSessionId;
      let resultError: string | null = null;
      let resultErrorCode: string | null = null;
      let stderr = "";
      let sawPartialText = false;
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
          if (lineType === "stream_event" && event.type === "text-delta") sawPartialText = true;
          if (lineType === "assistant" && sawPartialText && event.type === "text-delta") continue;
          if (event.type === "run-start" && event.nativeSessionId) nativeSessionId = event.nativeSessionId;
          if (event.type === "run-end") {
            nativeSessionId = event.nativeSessionId ?? nativeSessionId;
            output = event.result || output;
            if (event.isError) {
              resultError = event.result || "Claude Code run failed";
              resultErrorCode = classifyClaudeError(event.result);
            }
          }
          if (event.type === "runtime-error") {
            resultError = event.message;
            resultErrorCode = event.code;
          }
          if (event.type === "text-delta") output += event.delta;
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
        resolve({ output, nativeSessionId, error: resultError, errorCode: resultErrorCode });
      });
    });
  }

  subscribe(listener: (event: RuntimeEvent) => void): () => void {
    this.listeners.add(listener);
    if (!this.hasSubscribed) {
      this.hasSubscribed = true;
      for (const event of this.pendingEvents.splice(0)) listener(event);
    }
    return () => this.listeners.delete(listener);
  }

  abort(): void {
    if (this.settled || !this.child.pid) return;
    this.terminationCode = "aborted";
    this.stopChild();
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
    for (const listener of this.listeners) listener(event);
  }
}

export function classifyClaudeError(stderr: string): string {
  if (/auth|login|oauth|credential|token expired/i.test(stderr)) return "auth_required";
  if (/model|entitlement|not available|overloaded/i.test(stderr)) return "model_unavailable";
  if (/mcp|connection refused|unauthorized|401/i.test(stderr)) return "mcp_connection_failed";
  if (/permission|not allowed|denied/i.test(stderr)) return "permission_denied";
  if (/resume|session.*not found|conversation.*not found/i.test(stderr)) return "native_session_resume_failed";
  return "process_exit_failure";
}

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

interface ClaudeContentBlock {
  type?: string;
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
}

interface ClaudeLine {
  type?: string;
  session_id?: string;
  result?: string;
  is_error?: boolean;
  message?: {
    model?: string;
    content?: ClaudeContentBlock[];
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
    };
  };
  event?: {
    type?: string;
    delta?: { type?: string; text?: string };
  };
}

export function parseClaudeLine(line: string): RuntimeEvent[] {
  let value: ClaudeLine;
  try {
    value = JSON.parse(line) as ClaudeLine;
  } catch {
    return [{ type: "runtime-error", code: "malformed_stream_json", message: "Claude Code emitted malformed stream-json" }];
  }
  if (value.type === "system") {
    return value.session_id
      ? [{ type: "run-start", nativeSessionId: value.session_id }]
      : [{ type: "runtime-error", code: "invalid_system_event", message: "Claude Code system event is missing session_id" }];
  }
  if (
    value.type === "stream_event"
    && value.event?.type === "content_block_delta"
    && value.event.delta?.type === "text_delta"
  ) {
    return typeof value.event.delta.text === "string"
      ? [{ type: "text-delta", delta: value.event.delta.text }]
      : [{ type: "runtime-error", code: "invalid_stream_delta", message: "Claude Code text delta is missing text" }];
  }
  if (value.type === "result") {
    if (typeof value.result !== "string") {
      return [{ type: "runtime-error", code: "invalid_result_event", message: "Claude Code result event is missing result" }];
    }
    return [{
      type: "run-end",
      ...(value.session_id ? { nativeSessionId: value.session_id } : {}),
      result: value.result,
      isError: value.is_error === true,
    }];
  }
  const content = value.message?.content ?? [];
  if (value.type === "assistant") {
    if (!value.message || !Array.isArray(value.message.content)) {
      return [{ type: "runtime-error", code: "invalid_assistant_event", message: "Claude Code assistant event is missing content" }];
    }
    const events: RuntimeEvent[] = [];
    for (const block of content) {
      if (block.type === "text") {
        if (typeof block.text !== "string") {
          events.push({ type: "runtime-error", code: "invalid_text_block", message: "Claude Code text block is missing text" });
        } else if (block.text) events.push({ type: "text-delta", delta: block.text });
      }
      if (block.type === "tool_use") {
        if (!block.id || !block.name) {
          events.push({ type: "runtime-error", code: "invalid_tool_use", message: "Claude Code tool_use block is missing id or name" });
          continue;
        }
        events.push({
          type: "tool-start",
          callId: block.id,
          name: stripTradexMcpPrefix(block.name),
          args: block.input ?? {},
        });
      }
    }
    const usage = value.message?.usage;
    if (usage && value.message?.model) {
      events.push({
        type: "usage",
        model: value.message.model,
        input: usage.input_tokens ?? 0,
        output: usage.output_tokens ?? 0,
        cacheRead: usage.cache_read_input_tokens ?? 0,
        cacheWrite: usage.cache_creation_input_tokens ?? 0,
      });
    }
    return events;
  }
  if (value.type === "user") {
    if (!value.message || !Array.isArray(value.message.content)) {
      return [{ type: "runtime-error", code: "invalid_user_event", message: "Claude Code user event is missing content" }];
    }
    return content.flatMap((block): RuntimeEvent[] => {
      if (block.type !== "tool_result") return [];
      if (!block.tool_use_id) return [{ type: "runtime-error", code: "invalid_tool_result", message: "Claude Code tool_result block is missing tool_use_id" }];
      return [{
        type: "tool-end",
        callId: block.tool_use_id,
        output: contentToText(block.content),
        isError: block.is_error === true,
      }];
    });
  }
  return [];
}

function claudeLineType(line: string): string | null {
  try {
    const value = JSON.parse(line) as { type?: unknown };
    return typeof value.type === "string" ? value.type : null;
  } catch {
    return null;
  }
}

function stripTradexMcpPrefix(name: string): string {
  return name.startsWith("mcp__tradex__") ? name.slice("mcp__tradex__".length) : name;
}

function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return content == null ? "" : JSON.stringify(content);
  return content.map((item) => {
    if (item && typeof item === "object" && "text" in item && typeof item.text === "string") return item.text;
    return JSON.stringify(item);
  }).join("\n");
}
