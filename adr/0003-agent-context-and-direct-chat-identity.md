# ADR-0003：Agent Context 与 Direct Chat 身份

- 状态：已取代
- 日期：2026-07-18
- 被取代于：`0004-agent-context-and-direct-message-identity.md`
- 取代：ADR-0001 中将 Session 视为用户侧对话身份的部分

> **已取代。** 下文中的多 Direct Chat / New Chat / `direct-chat` ChatTarget 模型仅为历史记录。
> 请改读 ADR-0004 与 `docs/raft-style-agent-team-design.md`。

## 决策（历史）

Tradex 为每个 Agent 暴露一个稳定的 Direct Message Entry。Human 可在该入口下创建多个 Direct Chat，但同一时间只有一个 Chat 处于活跃且可写。一个 Chat 拥有一代或多代 Runtime Session；Native Session 仍是 Runtime 私有的 resume 句柄。

`AgentContextManager` 是可信的身份边界，负责：

- 确保某个 Agent 的活跃 Chat；
- 校验 `agentId + chatId` 归属；
- 仅在 Agent 空闲时允许创建 New Chat；
- 绑定与移除 Runtime Session 代际；
- 将已持久化的 Pi / Claude Session 索引为导入的 Chat。

Channel 相关操作继续使用 `channelId`。`ChatTarget` 不是 Channel 的替代品：仅当某一通用能力需要同时引用 `{ kind: "channel", channelId }` 或 `{ kind: "direct-chat", agentId, chatId }` 时才使用。Phase 1 将其用于 Chat 事件引用；未来的 Tasks 必须复用同一边界。

共享 Channel 消息始终是权威的 SQLite 事实，绝不会被直接追加到另一 Agent 的私有 Runtime Session。

## 后果（历史）

- New Chat 可开启干净的产品对话，而无需在侧栏复制 Agent。
- 既有 Session 文件只做索引，不迁移、不改写。
- 历史 Chat 只读，不可重新打开写入。
- Runtime 上下文轮转可新增 Session 代际，而不改变 Chat ID。
- Phase 2 的 Channel 激活可复用 Agent Context，无需另造一套 Channel 自有的模型上下文。
