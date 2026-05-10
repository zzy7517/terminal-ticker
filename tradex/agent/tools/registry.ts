export type ToolHandler = (...args: unknown[]) => Promise<string> | string;

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  handler: (args: Record<string, unknown>) => Promise<string> | string;
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
      const output = await tool.handler(effectiveCall.arguments);
      let result: ToolResult = { callId: effectiveCall.id, name: effectiveCall.name, output, error: false };
      for (const hook of this.afterToolHooks) {
        const replacement = await hook(effectiveCall, result, tool);
        if (replacement) result = replacement;
      }
      return result;
    } catch (error) {
      return { callId: effectiveCall.id, name: effectiveCall.name, output: error instanceof Error ? error.message : String(error), error: true };
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
