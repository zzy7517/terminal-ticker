# 一套 Tool 定义，按 Runtime 选用传输层

Tradex 在 Runtime 无关的注册表中为每个面向 Agent 的 Tool 只定义一次。Pi SDK 通过进程内适配器调用该注册表；Claude Code 等外部编码 Agent Runtime 则走经过认证的 MCP 传输。不会仅为让传输层看起来一致，就强迫 Pi 走回环 MCP。这样既避免重复实现业务 Tool，又保留 Pi 的取消、进度、图片、详情与终止语义；MCP 则为外部进程提供结构化、可复用的边界。

## 后果

Tool 策略以及入参/结果契约不得依赖 Pi 类型。对外 Runtime 的暴露默认拒绝，并需显式白名单；新增 Tool 不会自动授权给 Claude Code 或未来的 Codex Runtime。
