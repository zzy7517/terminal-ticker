/**
 * core/tool-adapter.ts — Bridges existing ToolRegistry/ToolDefinition to AgentTool[].
 *
 * The old system uses ToolRegistry with ToolDefinition (handler returns string).
 * The new core uses AgentTool (execute returns AgentToolResult).
 * This adapter converts between them so existing tool packs work unchanged.
 */

import { ToolRegistry, type ToolDefinition, type RichContentBlock } from "../tools/registry.js";
import type { AgentTool, AgentToolResult, AgentToolUpdateCallback, ImageContent, TextContent } from "./types.js";

/**
 * Convert a ToolRegistry into an AgentTool[].
 * Each tool's execute() wraps the old handler() and returns structured AgentToolResult.
 */
export function registryToAgentTools(registry: ToolRegistry): AgentTool[] {
  return registry.listTools().map((def) => toolDefinitionToAgentTool(def));
}

/**
 * Convert a single ToolDefinition to an AgentTool.
 */
export function toolDefinitionToAgentTool(def: ToolDefinition): AgentTool {
  return {
    name: def.name,
    description: def.description,
    parameters: def.parameters,
    execute: async (
      _toolCallId: string,
      args: Record<string, unknown>,
      _signal?: AbortSignal,
      _onUpdate?: AgentToolUpdateCallback,
    ): Promise<AgentToolResult> => {
      // Use richHandler when available to preserve structured content (images)
      if (def.richHandler) {
        const blocks = await def.richHandler(args);
        const content: (TextContent | ImageContent)[] = blocks.map((block: RichContentBlock) => {
          if (block.type === "image" && block.data && block.mimeType) {
            return { type: "image" as const, data: block.data, mimeType: block.mimeType };
          }
          return { type: "text" as const, text: block.text ?? "" };
        });
        return { content, details: {} };
      }
      const output = await def.handler(args);
      return {
        content: [{ type: "text", text: output }],
        details: {},
      };
    },
  };
}

/**
 * Convert AgentTool[] back to a ToolRegistry.
 * Useful for backward compat when legacy code still expects a ToolRegistry.
 */
export function agentToolsToRegistry(tools: AgentTool[]): ToolRegistry {
  const registry = new ToolRegistry();
  for (const tool of tools) {
    registry.register({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      handler: async (args: Record<string, unknown>): Promise<string> => {
        const result = await tool.execute("legacy-call", args);
        return result.content
          .filter((c): c is TextContent => c.type === "text")
          .map((c) => c.text)
          .join("\n");
      },
    });
  }
  return registry;
}
