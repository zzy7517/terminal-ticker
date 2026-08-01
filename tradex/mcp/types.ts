/**
 * MCP Client types for tradex.
 */
import type { ReadResourceResult, Resource, ResourceTemplate } from "@modelcontextprotocol/sdk/types.js";

import type { McpServerEntry, McpSettings } from "../contracts.js";

export type { McpServerEntry, McpSettings, McpServerStatus } from "../contracts.js";

/** Root MCP config shape (.mcp.json) */
export interface McpConfig {
  mcpServers: Record<string, McpServerEntry>;
  settings?: McpSettings;
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
