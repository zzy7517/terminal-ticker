/**
 * MCP Client types for tradex.
 */
import type { ReadResourceResult, Resource, ResourceTemplate } from "@modelcontextprotocol/sdk/types.js";

/** Server entry in .mcp.json config */
export interface McpServerEntry {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
  /** Idle timeout in minutes before disconnecting (default: 10, 0 to disable) */
  idleTimeout?: number;
}

/** Root MCP config shape (.mcp.json) */
export interface McpConfig {
  mcpServers: Record<string, McpServerEntry>;
  settings?: McpSettings;
}

/** Global MCP settings */
export interface McpSettings {
  /** Tool name prefix mode: "server" (default) | "none" | "short" */
  toolPrefix?: "server" | "none" | "short";
  /** Idle timeout in minutes (default: 10, 0 to disable) */
  idleTimeout?: number;
}

/** Parsed MCP config for AppConfig */
export interface McpAppConfig {
  enabled: boolean;
  configPath: string | null;
}

/** Tool metadata cached from MCP server */
export interface McpToolMeta {
  name: string;
  originalName: string;
  serverName: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** Resource metadata exposed by an MCP server. */
export type McpResourceMeta = Resource;

/** Resource template metadata exposed by an MCP server. */
export type McpResourceTemplateMeta = ResourceTemplate;

/** Resource read result returned by an MCP server. */
export type McpResourceReadResult = ReadResourceResult;

export interface McpResourceListResult {
  resources: McpResourceMeta[];
  nextCursor?: string;
}

export interface McpResourceTemplateListResult {
  resourceTemplates: McpResourceTemplateMeta[];
  nextCursor?: string;
}

export interface McpResourceListError {
  serverName: string;
  error: string;
}

export interface McpAllResourcesResult {
  resources: Record<string, McpResourceMeta[]>;
  errors: McpResourceListError[];
}

export interface McpAllResourceTemplatesResult {
  resourceTemplates: Record<string, McpResourceTemplateMeta[]>;
  errors: McpResourceListError[];
}

/** Connection status for a server */
export type McpServerStatus = "idle" | "connecting" | "connected" | "failed";
