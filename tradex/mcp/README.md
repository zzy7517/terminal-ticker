# MCP Client Integration

Tradex can connect to external MCP servers and expose their tools to the agent.

## Quick Start

Create a `.mcp.json` in your project root:

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"]
    },
    "my-api": {
      "url": "http://localhost:3001/mcp"
    }
  }
}
```

Start tradex — the agent will now have access to these tools via the `mcp` proxy tool.

## Configuration

### watchlist.toml

```toml
[mcp]
enabled = true
config_path = ".mcp.json"  # optional, defaults to .mcp.json in cwd
```

### .mcp.json format

Standard MCP config format (compatible with Claude Desktop, Cursor, VS Code, etc.):

```json
{
  "mcpServers": {
    "server-name": {
      "command": "npx",
      "args": ["-y", "some-mcp-server"],
      "env": { "API_KEY": "..." },
      "lifecycle": "lazy",
      "directTools": false
    }
  },
  "settings": {
    "toolPrefix": "server",
    "idleTimeout": 10,
    "directTools": false
  }
}
```

### Server entry fields

| Field | Type | Description |
|-------|------|-------------|
| `command` | string | Executable to spawn (stdio transport) |
| `args` | string[] | Command line arguments |
| `env` | object | Extra environment variables |
| `cwd` | string | Working directory for the process |
| `url` | string | HTTP URL (Streamable HTTP / SSE transport) |
| `headers` | object | Extra HTTP headers |
| `lifecycle` | "lazy" \| "eager" | When to connect (default: lazy) |
| `idleTimeout` | number | Minutes before disconnect (default: 10, 0 = never) |
| `directTools` | boolean \| string[] | Register tools directly instead of behind proxy |

### Settings

| Field | Type | Description |
|-------|------|-------------|
| `toolPrefix` | "server" \| "none" \| "short" | How to prefix tool names (default: "server") |
| `idleTimeout` | number | Global idle timeout in minutes |
| `directTools` | boolean | Register all tools directly |

## How it works

### Proxy mode (default)

One `mcp` tool is registered (~200 tokens). The agent uses it to:
- **Status**: `mcp({})` — see configured servers
- **Connect**: `mcp({ connect: "server-name" })` — connect and list tools
- **Search**: `mcp({ search: "query" })` — find tools by name/description
- **Describe**: `mcp({ describe: "tool_name" })` — see full schema
- **Call**: `mcp({ tool: "tool_name", args: '{"key": "value"}' })` — execute

### Direct mode

Set `directTools: true` on a server (or globally) to register each MCP tool as a separate tool in the agent's ToolRegistry. More convenient for the agent but uses more context tokens.

```json
{
  "mcpServers": {
    "database": {
      "command": "npx",
      "args": ["-y", "mcp-server-sqlite", "mydb.sqlite"],
      "directTools": true
    }
  }
}
```

You can also select specific tools:
```json
{
  "directTools": ["query", "list_tables"]
}
```

## Lifecycle

- **Lazy (default)**: Servers connect on first tool call
- **Eager**: Servers connect at startup (required for direct mode tools to be immediately available)
- **Idle timeout**: Servers disconnect after N minutes of inactivity (default: 10 min)
- **Graceful shutdown**: All connections close when tradex stops
