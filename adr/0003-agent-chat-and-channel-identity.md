# ADR-0003：Agent Chat 与 Channel 身份

状态：已取代

日期：2026-07-18

被取代于：`0004-agent-context-and-direct-message-identity.md`

> **已取代。** 下文中的多 Direct Chat / New Chat / `direct-chat` 寻址模型仅为历史记录。
> 请改读 ADR-0004 与 `docs/raft-style-agent-team-design.md`。

## 决策（历史）

- Direct Message Entry 以 `agentId` 为键，在导航中只出现一次。
- Direct Chat 以 `chatId` 为键；一个 Agent 可拥有多个 Chat，且至多一个活跃 Chat。
- Human 的 `New Chat` 会创建干净的 Chat，并归档此前的活跃 Chat。
- Tradex Session 属于某一代 Chat。由 Runtime 驱动的 Session 轮转不会创建新 Chat。
- Channel 是共享的 SQLite 对话，从不复用 Agent 的私有 Session 作为消息存储。
- 已移除的全局 Memory 管线不再复用。未来的 Agent 记忆实现必须在 Agent Context 接缝处以可信的 `agentId` 划定作用域。

## 后果（历史）

- 既有 Session 被索引为导入的 Chat，且不改写其文件。
- 未来的 Tasks 可指向 `{ kind: "direct-chat", agentId, chatId }` 或 `{ kind: "channel", channelId }`，而无需引入另一套对话身份。
- 首版实现中，历史 Chat 可读但不可写。
