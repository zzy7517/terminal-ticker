/**
 * core/tool-adapter.ts — Bridges ToolRegistry/ToolDefinition to AgentTool[].
 *
 * The new core (mirroring pi's design) consumes AgentTool[] whose `execute`
 * always returns AgentToolResult { content, details, terminate? }.
 *
 * Each tradex ToolDefinition.execute may return:
 *   • a string                                  → wrapped as text content
 *   • a ContentBlock[]                          → used as content directly
 *   • a { content, details?, terminate? }       → forwarded as-is (pi shape)
 *
 * This adapter normalizes all three shapes. Errors thrown by tools surface as
 * AgentToolResult with isError=true semantics (the loop tags them via the
 * containing event), matching pi's "throw on failure" contract.
 */

import { ToolRegistry, normalizeToolReturn, type ToolDefinition } from "../tools/registry.js";
import type {
  AgentTool,
  AgentToolResult,
  AgentToolUpdateCallback,
  TextContent,
} from "./types.js";

/** Convert a ToolRegistry into an AgentTool[]. */
export function registryToAgentTools(registry: ToolRegistry): AgentTool[] {
  return registry.listTools().map((def) => toolDefinitionToAgentTool(def));
}

/** Convert a single ToolDefinition into an AgentTool. */
export function toolDefinitionToAgentTool(def: ToolDefinition): AgentTool {
  return {
    name: def.name,
    description: def.description,
    parameters: def.parameters,
    executionMode: def.executionMode,
    execute: async (
      _toolCallId: string,
      args: Record<string, unknown>,
      signal?: AbortSignal,
      onUpdate?: AgentToolUpdateCallback,
    ): Promise<AgentToolResult> => {
      const raw = await def.execute(args, signal, onUpdate);
      const normalized = normalizeToolReturn(raw);
      return {
        content: normalized.content,
        details: normalized.details,
        terminate: normalized.terminate,
      };
    },
  };
}

/**
 * Convert AgentTool[] back to a ToolRegistry.
 * Used for backward compatibility with code that still expects ToolRegistry.
 * Note: image content is dropped here — text-only consumers should not be
 * receiving images anyway, and this fallback exists purely for legacy paths.
 */
export function agentToolsToRegistry(tools: AgentTool[]): ToolRegistry {
  const registry = new ToolRegistry();
  for (const tool of tools) {
    registry.register({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      executionMode: tool.executionMode,
      execute: async (args: Record<string, unknown>) => {
        const result = await tool.execute("legacy-call", args);
        const text = result.content
          .filter((c): c is TextContent => c.type === "text")
          .map((c) => c.text)
          .join("\n");
        return text;
      },
    });
  }
  return registry;
}
