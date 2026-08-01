/**
 * external-cli-registry — 外接 CLI Runtime（Claude Code / Cursor）的统一工厂接缝。
 *
 * 两个 Runtime 的调用形状完全一致（detect → start → result），差异全部收敛到
 * 各自的 descriptor 里：CLI 指令文案、时间工具名、effort 是否受支持等。
 * 调用方按 `EXTERNAL_CLI_RUNTIMES[id]` 取 descriptor，不再对 runtime id 分支。
 *
 * Pi SDK Runtime 是进程内执行，形状本质不同，刻意不塞进本接缝。
 */
import type { ToolRegistry } from "../tools/registry.js";
import type { ActiveRuntimeRun, ExternalAgentRuntimeId } from "./types.js";
import type { CliRunGrantStore } from "./cli-tools.js";
import { ClaudeCodeRuntime, exposeClaudeReadTools } from "./claude-code/runtime.js";
import { detectClaudeCode } from "./claude-code/discovery.js";
import { CursorCliRuntime, exposeCursorReadTools } from "./cursor/runtime.js";
import { detectCursorCli } from "./cursor/discovery.js";
import { CLAUDE_CLI_INSTRUCTIONS, CURSOR_CLI_INSTRUCTIONS } from "../prompts.js";

export type ExternalCliRuntimeId = ExternalAgentRuntimeId;

/** 两个外接 CLI 的可用性结果结构相同；id 由 descriptor 补充。 */
export interface ExternalCliAvailability {
  available: boolean;
  executablePath: string;
  version: string | null;
  error: string | null;
}

/** 统一的 run 入参；descriptor 负责丢弃该 Runtime 不支持的字段（如 Cursor 的 effort）。 */
export interface ExternalCliRunInput {
  tradexSessionId: string;
  cwd: string;
  prompt: string;
  instructions: string;
  registry: ToolRegistry;
  nativeSessionId?: string;
  model?: string | null;
  effort?: string | null;
  preserveNativeSystemPrompt?: boolean;
}

export interface ExternalCliStartOptions {
  executablePath: string;
  cliUrl: string;
  grants: CliRunGrantStore;
}

export interface ExternalCliRuntimeDescriptor {
  readonly id: ExternalCliRuntimeId;
  /** 人类可读名，用于错误信息。 */
  readonly label: string;
  /** 追加在 Agent 指令后的 CLI 使用说明。 */
  readonly cliInstructions: string;
  /** currentTimeInstruction 引用的工具名（Claude 是 Bash，Cursor 是 shell）。 */
  readonly timeToolName: "Bash" | "shell";
  /** Runtime 是否在事件流中上报 token usage。 */
  readonly usageReporting: "reported" | "none";
  /** Session 流场景追加的能力边界声明（两个 Runtime 的措辞略有不同）。 */
  readonly sessionGuardrail: string;
  detect(): Promise<ExternalCliAvailability>;
  /** 只读工具白名单投影（Runtime 各自维护自己的工具面）。 */
  exposeReadTools(registry: ToolRegistry): ToolRegistry;
  /** 启动一次 run。不支持的入参字段在此处丢弃，调用方无需分支。 */
  start(options: ExternalCliStartOptions, input: ExternalCliRunInput): Promise<ActiveRuntimeRun>;
}

const claudeCode: ExternalCliRuntimeDescriptor = {
  id: "claude-code",
  label: "Claude Code",
  cliInstructions: CLAUDE_CLI_INSTRUCTIONS,
  timeToolName: "Bash",
  usageReporting: "reported",
  sessionGuardrail:
    "Do not place trades, modify files, configure additional tool servers, or claim those capabilities are available.",
  detect: () => detectClaudeCode(),
  exposeReadTools: exposeClaudeReadTools,
  start: (options, input) =>
    new ClaudeCodeRuntime(options).start({
      tradexSessionId: input.tradexSessionId,
      cwd: input.cwd,
      prompt: input.prompt,
      instructions: input.instructions,
      preserveNativeSystemPrompt: input.preserveNativeSystemPrompt,
      registry: input.registry,
      nativeSessionId: input.nativeSessionId,
      model: input.model,
      effort: input.effort,
    }),
};

const cursor: ExternalCliRuntimeDescriptor = {
  id: "cursor",
  label: "Cursor CLI",
  cliInstructions: CURSOR_CLI_INSTRUCTIONS,
  timeToolName: "shell",
  usageReporting: "none",
  sessionGuardrail:
    "Do not place trades, access Memory outside this workspace, configure additional tool servers, or claim those capabilities are available.",
  detect: () => detectCursorCli(),
  exposeReadTools: exposeCursorReadTools,
  // Cursor CLI 不支持 effort 与 preserveNativeSystemPrompt；在接缝内丢弃。
  start: (options, input) =>
    new CursorCliRuntime(options).start({
      tradexSessionId: input.tradexSessionId,
      cwd: input.cwd,
      prompt: input.prompt,
      instructions: input.instructions,
      registry: input.registry,
      nativeSessionId: input.nativeSessionId,
      model: input.model,
    }),
};

export const EXTERNAL_CLI_RUNTIMES: Record<ExternalCliRuntimeId, ExternalCliRuntimeDescriptor> = {
  "claude-code": claudeCode,
  cursor,
};

export function isExternalCliRuntime(id: string): id is ExternalCliRuntimeId {
  return id === "claude-code" || id === "cursor";
}
