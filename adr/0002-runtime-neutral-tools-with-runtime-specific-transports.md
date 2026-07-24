# 一套 Tool 定义，统一经 session-scoped CLI 暴露

Tradex 在 Runtime 无关的注册表（`ToolRegistry`）中为每个面向 Agent 的业务 Tool 只定义一次。Pi SDK、Claude Code、Cursor Agent 等 Runtime 不再各自再实现一份工具，也不再通过 Tradex 自建 MCP server（如 `/mcp/tradex`、`mcp__tradex__*`）注入业务能力。

Agent 工具传输统一为：

`ToolRegistry` → 每次 run 的 CLI grant（短期 token + 工具白名单 + Session 绑定）→ loopback `/cli/tradex` → Session 内临时 `tradex` 命令（`tradex tool list|describe|call`）

各 Runtime 只保留各自原生的编码能力（读文件、shell 等）；业务 Tool 一律经 shell 调用上述 CLI。权限过滤（如外接 Runtime 禁止交易 write）、Session 绑定与 loopback 限制仍在 grant / gateway 层执行，不写进各个 Runtime 的启动参数。

外部 MCP（`.mcp.json`、jin10、Exa 等）仍可作为**数据源 / 上游适配器**：由 Tradex 作为 MCP 客户端拉取工具并并入同一份 `ToolRegistry`，再经 CLI 暴露给 Agent。它不是 Agent 工具传输层，也不再把 Tradex 自身暴露为 MCP server。

## 后果

Tool 策略以及入参/结果契约不得依赖某一 Runtime 的 SDK 类型。对外 Runtime 的暴露默认拒绝，并需显式白名单；新增 Tool 不会自动授权给 Claude Code、Cursor 或未来的 Codex Runtime。Agent 与文档不得再引导去 MCP 目录查找 Tradex 业务工具；唤醒与操作说明应指向 `tradex tool call ...`。
