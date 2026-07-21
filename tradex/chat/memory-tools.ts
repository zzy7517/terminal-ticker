/**
 * memory-tools — per-Agent 私有 MEMORY 工具（与 Message Fabric 分 Module）。
 *
 * 写入失败不得回滚 Shared Message / inbox；调用方应视为独立 seam。
 */
import type { ToolRegistry, ToolDefinition } from "../agent/tools/registry.js";
import {
  memoryApplyRetention,
  memoryCompact,
  memoryRead,
  memorySearch,
  memoryWrite,
} from "../agent/memory.js";

const BOTH = ["pi", "claude-code", "cursor"] as const;

function text(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function tool(
  name: string,
  description: string,
  parameters: Record<string, unknown>,
  execute: ToolDefinition["execute"],
  access: "read" | "write" = "read",
): ToolDefinition {
  return {
    name,
    description,
    parameters,
    execute,
    policy: { access, domain: "other", runtimeExposure: BOTH },
  };
}

/** 把 memory_* 工具注册进已有 registry（由 createMessageToolRegistry 组合）。 */
export function registerMemoryTools(registry: ToolRegistry, agentId: string): void {
  registry.register(tool(
    "memory_read",
    "Read this Agent's private MEMORY.md.",
    { type: "object", properties: {}, additionalProperties: false },
    async () => text({ content: memoryRead(agentId) }),
  ));

  registry.register(tool(
    "memory_write",
    "Replace this Agent's private MEMORY.md.",
    {
      type: "object",
      properties: { content: { type: "string" } },
      required: ["content"],
      additionalProperties: false,
    },
    async (args) => {
      try {
        memoryWrite(agentId, String(args.content ?? ""));
        return text({ ok: true });
      } catch (error) {
        throw new Error(`memory write failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
    "write",
  ));

  registry.register(tool(
    "memory_search",
    "Search this Agent's private MEMORY.md by keyword.",
    {
      type: "object",
      properties: {
        query: { type: "string" },
        limit: { type: "number" },
      },
      required: ["query"],
      additionalProperties: false,
    },
    async (args) => text({
      hits: memorySearch(
        agentId,
        String(args.query ?? ""),
        typeof args.limit === "number" ? args.limit : 20,
      ),
    }),
  ));

  registry.register(tool(
    "memory_compact",
    "Compact this Agent's private MEMORY.md when it grows too large. Archives overflow locally.",
    { type: "object", properties: {}, additionalProperties: false },
    async () => text(memoryCompact(agentId)),
    "write",
  ));

  registry.register(tool(
    "memory_apply_retention",
    "Archive stale private workspace notes older than retentionDays (default 180).",
    {
      type: "object",
      properties: { retentionDays: { type: "number" } },
      additionalProperties: false,
    },
    async (args) => text(memoryApplyRetention(
      agentId,
      typeof args.retentionDays === "number" ? args.retentionDays : undefined,
    )),
    "write",
  ));
}
