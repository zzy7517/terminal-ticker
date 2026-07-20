/** MCP 服务器管理客户端。 */
import type {
  McpReadResourceResponse,
  McpServerEntry,
  McpServerResourcesResponse,
  McpServerResourceTemplatesResponse,
  McpServerToolsResponse,
  McpSettings,
  McpStatusResponse,
} from '../types';
import { responseError } from './http';

export async function fetchMcpStatus(): Promise<McpStatusResponse> {
  const response = await fetch('/api/mcp/status');
  if (!response.ok) throw await responseError(response, 'fetch MCP status failed');
  return response.json();
}

export async function connectMcpServer(name: string): Promise<{ server: string; status: string; toolCount?: number; tools?: { name: string; description: string }[]; error?: string }> {
  const response = await fetch(`/api/mcp/servers/${encodeURIComponent(name)}/connect`, { method: 'POST' });
  if (!response.ok) throw await responseError(response, 'MCP connect failed');
  return response.json();
}

export async function disconnectMcpServer(name: string): Promise<{ server: string; status: string }> {
  const response = await fetch(`/api/mcp/servers/${encodeURIComponent(name)}/disconnect`, { method: 'POST' });
  if (!response.ok) throw await responseError(response, 'MCP disconnect failed');
  return response.json();
}

export async function fetchMcpServerTools(name: string): Promise<McpServerToolsResponse> {
  const response = await fetch(`/api/mcp/servers/${encodeURIComponent(name)}/tools`);
  if (!response.ok) throw await responseError(response, 'fetch MCP tools failed');
  return response.json();
}

export async function fetchMcpServerResources(name: string, cursor?: string): Promise<McpServerResourcesResponse> {
  const params = cursor ? `?cursor=${encodeURIComponent(cursor)}` : '';
  const response = await fetch(`/api/mcp/servers/${encodeURIComponent(name)}/resources${params}`);
  if (!response.ok) throw await responseError(response, 'fetch MCP server resources failed');
  return response.json();
}

export async function fetchMcpServerResourceTemplates(name: string, cursor?: string): Promise<McpServerResourceTemplatesResponse> {
  const params = cursor ? `?cursor=${encodeURIComponent(cursor)}` : '';
  const response = await fetch(`/api/mcp/servers/${encodeURIComponent(name)}/resource-templates${params}`);
  if (!response.ok) throw await responseError(response, 'fetch MCP server resource templates failed');
  return response.json();
}

export async function readMcpResource(name: string, uri: string): Promise<McpReadResourceResponse> {
  const response = await fetch(`/api/mcp/servers/${encodeURIComponent(name)}/resources/read`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ uri }),
  });
  if (!response.ok) throw await responseError(response, 'read MCP resource failed');
  return response.json();
}

export async function updateMcpSettings(settings: McpSettings): Promise<{ ok: boolean; settings: McpSettings }> {
  const response = await fetch('/api/mcp/config', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ settings }),
  });
  if (!response.ok) throw await responseError(response, 'update MCP settings failed');
  return response.json();
}

export async function addMcpServer(name: string, config: McpServerEntry): Promise<{ ok: boolean; server: string }> {
  const response = await fetch('/api/mcp/servers', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, config }),
  });
  if (!response.ok) throw await responseError(response, 'add MCP server failed');
  return response.json();
}

export async function updateMcpServer(name: string, config: McpServerEntry): Promise<{ ok: boolean; server: string }> {
  const response = await fetch(`/api/mcp/servers/${encodeURIComponent(name)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ config }),
  });
  if (!response.ok) throw await responseError(response, 'update MCP server failed');
  return response.json();
}

export async function deleteMcpServer(name: string): Promise<{ ok: boolean }> {
  const response = await fetch(`/api/mcp/servers/${encodeURIComponent(name)}`, { method: 'DELETE' });
  if (!response.ok) throw await responseError(response, 'delete MCP server failed');
  return response.json();
}
