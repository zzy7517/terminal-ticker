/**
 * tools/registry.ts — Tool definition + registry.
 *
 * Each tool has a single `execute` method. The canonical result shape is
 * { content, details?, terminate? } where `content` is an array of
 * TextContent | ImageContent blocks. Errors are signaled by throwing.
 *
 * For pragmatic back-compat with tradex's existing 30+ tools, `execute` may
 * also return:
 *   • a plain string (auto-wrapped to [{ type: "text", text }]); or
 *   • a bare ContentBlock[] (treated as { content, details: undefined }).
 *
 * The tool-adapter normalizes all three shapes before handing them to the
 * agent loop. New tools should prefer the canonical result shape.
 */

import type {
  AgentToolUpdateCallback,
  ImageContent,
  TextContent,
  ToolExecutionMode,
} from "../core/types.js";

/** Single text or image block returned to the model. */
export type ContentBlock = TextContent | ImageContent;

/**
 * Canonical tool execution result.
 */
export interface ToolHandlerResult<TDetails = unknown> {
  /** Content blocks returned to the model. */
  content: ContentBlock[];
  /** Optional structured details for logs / UI rendering (not sent to model). */
  details?: TDetails;
  /**
   * Hint that the agent loop should stop after this tool batch.
   * Termination only occurs when every finalized tool result in the batch
   * sets this to true.
   */
  terminate?: boolean;
}

/**
 * Permitted return values for `ToolDefinition.execute`.
 *
 * The first two forms are convenience sugar for tools that only ever return
 * text or only ever return content blocks. The third form is the canonical
 * result that supports `details` and `terminate`.
 */
export type ToolReturnValue<TDetails = unknown> =
  | string
  | ContentBlock[]
  | ToolHandlerResult<TDetails>;

/**
 * Tool execute signature (without `toolCallId` first argument).
 */
export type ToolExecuteFn<TDetails = unknown> = (
  args: Record<string, unknown>,
  signal?: AbortSignal,
  onUpdate?: AgentToolUpdateCallback<TDetails>,
) => Promise<ToolReturnValue<TDetails>> | ToolReturnValue<TDetails>;

export interface ToolDefinition<TDetails = unknown> {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  /**
   * Execute the tool call. Throw on failure — unhandled errors are caught by
   * the registry / adapter and surfaced as a tool error to the model.
   */
  execute: ToolExecuteFn<TDetails>;
  /** Per-tool execution mode override. */
  executionMode?: ToolExecutionMode;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ToolResult {
  callId: string;
  name: string;
  output: string;
  error: boolean;
}

export type BeforeToolHook = (call: ToolCall, tool: ToolDefinition) => ToolCall | null | Promise<ToolCall | null>;
export type AfterToolHook = (call: ToolCall, result: ToolResult, tool: ToolDefinition) => ToolResult | null | Promise<ToolResult | null>;

/** Coerce any permitted ToolReturnValue into a canonical ToolHandlerResult. */
export function normalizeToolReturn<TDetails = unknown>(
  value: ToolReturnValue<TDetails>,
): ToolHandlerResult<TDetails> {
  if (typeof value === "string") {
    return { content: [{ type: "text", text: value }] };
  }
  if (Array.isArray(value)) {
    return { content: value };
  }
  return value;
}

/** Flatten content blocks into the plain-text representation used by ToolResult.output. */
export function contentToText(content: ContentBlock[]): string {
  return content
    .filter((c): c is TextContent => c.type === "text")
    .map((c) => c.text)
    .join("\n");
}

export class ToolRegistry {
  private readonly tools = new Map<string, ToolDefinition>();
  private beforeToolHooks: BeforeToolHook[];
  private afterToolHooks: AfterToolHook[];

  constructor(input: { beforeToolHooks?: BeforeToolHook[]; afterToolHooks?: AfterToolHook[] } = {}) {
    this.beforeToolHooks = input.beforeToolHooks ?? [];
    this.afterToolHooks = input.afterToolHooks ?? [];
  }

  extendHooks(input: { beforeToolHooks?: BeforeToolHook[]; afterToolHooks?: AfterToolHook[] }): void {
    this.beforeToolHooks.push(...(input.beforeToolHooks ?? []));
    this.afterToolHooks.push(...(input.afterToolHooks ?? []));
  }

  register(tool: ToolDefinition): void {
    this.tools.set(tool.name, tool);
  }

  get(name: string): ToolDefinition | null {
    return this.tools.get(name) ?? null;
  }

  listTools(): ToolDefinition[] {
    return [...this.tools.values()];
  }

  openaiToolSchemas(): Array<Record<string, unknown>> {
    return this.listTools().map((tool) => ({
      type: "function",
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      },
    }));
  }

  codexToolSchemas(): Array<Record<string, unknown>> {
    return this.listTools().map((tool) => ({
      type: "function",
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    }));
  }

  async execute(call: ToolCall): Promise<ToolResult> {
    const tool = this.tools.get(call.name);
    if (!tool) return { callId: call.id, name: call.name, output: `Unknown tool: ${call.name}`, error: true };
    let effectiveCall = call;
    try {
      for (const hook of this.beforeToolHooks) {
        const replacement = await hook(effectiveCall, tool);
        if (replacement) effectiveCall = replacement;
      }
      const raw = await tool.execute(effectiveCall.arguments);
      const normalized = normalizeToolReturn(raw);
      const output = contentToText(normalized.content);
      let result: ToolResult = { callId: effectiveCall.id, name: effectiveCall.name, output, error: false };
      for (const hook of this.afterToolHooks) {
        const replacement = await hook(effectiveCall, result, tool);
        if (replacement) result = replacement;
      }
      return result;
    } catch (error) {
      return {
        callId: effectiveCall.id,
        name: effectiveCall.name,
        output: error instanceof Error ? error.message : String(error),
        error: true,
      };
    }
  }
}

export function jsonOutput(data: unknown): string {
  return JSON.stringify(data);
}

export function mergeRegistries(...registries: ToolRegistry[]): ToolRegistry {
  const merged = new ToolRegistry();
  for (const registry of registries) {
    for (const tool of registry.listTools()) merged.register(tool);
  }
  return merged;
}
