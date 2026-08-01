/** MCP 服务器、工具与资源 DTO。 */

import type { McpServerStatus, McpSettings } from '../../../tradex/contracts';

export type { McpServerEntry, McpServerStatus, McpSettings } from '../../../tradex/contracts';

export interface McpServerInfo {
  name: string;
  status: McpServerStatus;
  type: 'stdio' | 'http';
  toolCount: number;
  command: string | null;
  url: string | null;
  args: string[];
  env: string[];
  cwd: string | null;
  idleTimeout: number | null;
}

export interface McpStatusResponse {
  enabled: boolean;
  configured: boolean;
  servers: McpServerInfo[];
  settings: McpSettings | null;
}

export interface McpToolInfo {
  name: string;
  originalName: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface McpServerToolsResponse {
  server: string;
  status: McpServerStatus;
  tools: McpToolInfo[];
}

export interface McpResourceInfo {
  server?: string;
  uri: string;
  name: string;
  title?: string;
  description?: string;
  mimeType?: string;
  size?: number;
  annotations?: Record<string, unknown>;
  _meta?: Record<string, unknown>;
}

export interface McpResourceTemplateInfo {
  server?: string;
  uriTemplate: string;
  name: string;
  title?: string;
  description?: string;
  mimeType?: string;
  annotations?: Record<string, unknown>;
  _meta?: Record<string, unknown>;
}

export interface McpResourceContent {
  uri: string;
  mimeType?: string;
  text?: string;
  blob?: string;
  _meta?: Record<string, unknown>;
}

export interface McpServerResourcesResponse {
  server: string;
  status: McpServerStatus;
  resources: McpResourceInfo[];
  nextCursor: string | null;
}

export interface McpServerResourceTemplatesResponse {
  server: string;
  status: McpServerStatus;
  resourceTemplates: McpResourceTemplateInfo[];
  nextCursor: string | null;
}

export interface McpReadResourceResponse {
  server: string;
  uri: string;
  contents: McpResourceContent[];
}

