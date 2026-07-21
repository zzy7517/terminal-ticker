/** 外接编码 Runtime 共用的 Tradex MCP 配置辅助。 */

export interface TradexMcpServerConfig {
  type: "http";
  url: string;
  headers: { Authorization: string };
}

/** 构造带短期 Bearer grant 的 Tradex MCP server 配置。 */
export function buildTradexMcpServerConfig(input: { url: string; token: string }): TradexMcpServerConfig {
  return {
    type: "http",
    url: input.url,
    headers: { Authorization: `Bearer ${input.token}` },
  };
}

/** 写成 Claude `--mcp-config` / Cursor `.cursor/mcp.json` 可用的根对象。 */
export function buildTradexMcpConfigFile(input: { url: string; token: string }): {
  mcpServers: { tradex: TradexMcpServerConfig };
} {
  return { mcpServers: { tradex: buildTradexMcpServerConfig(input) } };
}
