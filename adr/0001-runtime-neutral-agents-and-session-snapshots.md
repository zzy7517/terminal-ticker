# 保持 Agent 与 Runtime 解耦，并在 Session 中快照 Agent

Tradex 将每个 Agent 存为带 Runtime 标签的配置，且不依赖 Pi SDK——即便初期只有 `pi` 一种 Runtime，未来接入 Claude Code 或 Codex 执行后端时也不必重新定义 Agent 身份。Session 在收到第一条用户消息前仅驻留内存；首次消息后，会把所选 Agent 的不可变快照与对话一并持久化。之后对 Agent 的编辑只影响新 Session，从而保证既有对话内的行为可复现。

## 后果

内置 Default Agent 无需本地配置即可使用，可被覆盖但不可删除。缺少 Agent 元数据的既有 Session 归属于 Default Agent；在 Session 内修改模型仅作用于该 Session。
