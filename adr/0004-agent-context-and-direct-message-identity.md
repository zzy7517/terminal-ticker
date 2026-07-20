# ADR-0004：Agent Context 与 Direct Message 身份

- 状态：已接受
- 日期：2026-07-19
- 接受日期：2026-07-19
- 取代：
  - `0003-agent-context-and-direct-chat-identity.md`
  - `0003-agent-chat-and-channel-identity.md`
- 对齐：`docs/raft-style-agent-team-design.md`（修订于 2026-07-19）

## 背景

Phase 1 引入了 Direct Chat 模型：每个 Agent 一个侧栏入口、入口下可有多个 Chat、支持 New Chat，以及形如 `{ kind: "direct-chat", agentId, chatId }` 的 `ChatTarget`。当时把 `AgentContextManager` 描述为拥有活跃 Chat 生命周期。

Raft Cursor Agent 的实证与 Raft 风格 Agent Team 设计修订了该边界：

- 面向 Agent 的目标是稳定的 `dm:@recipient` 字符串，而非用户可见的 `chatId`。
- 观察到的产品形态中没有 New Chat，也没有 Chat 历史选择器。
- 每一对参与者只有一条 Direct Message；每个 Agent 只有一个逻辑上的下游 Agent Context。
- 共享消息存放在 SQLite 中；它们不是 Agent 的私有 Runtime Session。

若继续沿用 ADR-0003 的多 Chat 表述，会与设计文档以及树内已有的 Phase 1.5 代码方向冲突。

## 决策

### Direct Message

- Tradex 在 Human 导航中为每个 Agent 暴露**一个稳定的 Direct Message Entry**，以 `agentId` 为键。
- **Direct Message** 是规范化参与者对（Human–Agent 或 Agent–Agent）的唯一 1:1 对话。
- **没有**用户可见的 `chatId`，**没有** New Chat，也**没有** Chat 历史选择器。
- UI、API 与 Agent Tool 都投影该参与者对上同一条唯一的 DM 时间线。
- Runtime Session 轮转（溢出、配置变更、resume 失败）**不会**创建新的 DM，也不会改变 DM 身份。

### 所有权接缝

- **`MessageStore`** 拥有 Direct Message 对话身份，以及 `chat.sqlite3` 中权威的 DM 消息时间线。
- **`AgentContextManager`** 拥有仅以 `agentId` 为键的 Agent Context 边界：
  - ensure / status Agent Context；
  - 绑定、轮转与移除 Runtime Session 代际；
  - 将 Native Session ID 作为 Runtime 私有的 resume 句柄持有；
  - 将已持久化的 Pi / Claude Session 索引为导入的 **session generations**（而非独立的产品 Chat）。
- `AgentContextManager` **不**拥有 Chat 生命周期 API（`ensureActiveChat`、`createNewChat`、`listChats`、`requireChat`）。

### ChatTarget

Channel 相关操作继续使用 `channelId`。

`ChatTarget` 仅用于必须同时引用 Channel 或 Direct Message 的通用能力（Chat 事件，以及未来的 Tasks）：

- `{ kind: "channel", channelId }`
- `{ kind: "direct-message", directMessageId }`

`{ kind: "direct-chat", agentId, chatId }` **已退役**。遗留行可读以供迁移，随后改写为 `direct-message`。

面向 Agent 的 Message Target 仍是简单字符串（`#channel`、`dm:@handle`、`#channel:<messageId>`），仅在 Message Tool 边界解析为可信的 `ChatTarget`。

### 共享事实 vs 私有上下文

- Channel 与 Direct Message 正文是 Shared Message Fabric 中的权威 SQLite 事实。
- 它们绝不会被直接追加进另一 Agent 的私有 Runtime Session 作为事实来源。
- Inbox / Activation 以无正文通知唤醒 Agent；Agent 按需通过 Message Tool 读取目标。
- 每个 Agent 在 DM、Channel 与提醒之上只有一个逻辑 Agent Context。

## 后果

- Phase 1 的多 Chat / New Chat 产品面被移除，或视为已迁移的遗留形态。
- 既有 Session 文件仍作为执行归档留在磁盘上；消息可幂等地导入唯一的 Human–Agent DM。
- 若存在历史多 Chat 数据，会折叠进一条 DM 时间线，而不再以可写/只读的归档 Chat 实体保留。
- ADR-0003 文档仅为历史；实现者应遵循本 ADR 与 `raft-style-agent-team-design.md`。
- `CONTEXT.md` 词汇采用 Direct Message（每对参与者唯一），并将 Chat 视为 UI 外壳，而非多 Chat 产品实体。
- 未来的 Tasks 复用同一 `ChatTarget` 边界（`direct-message` | `channel`），不引入第三种对话身份。

## 否决的替代方案

- 保留多 Chat + New Chat，以贴合原 ADR-0003 文本。
- 继续让 `AgentContextManager` 拥有 `chatId` 生命周期。
- 将 `direct-chat` 作为长期的 `ChatTarget` kind 保留。
- 用 Agent 的私有 Runtime Session 作为权威 DM 消息存储。
