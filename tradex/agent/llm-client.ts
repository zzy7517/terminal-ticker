/**
 * llm-client.ts — 轻量级 LLM 聊天客户端接口。
 *
 * 供只需要单次、非流式感知、非 agentic 调用的代码路径使用
 * （例如非 agentic 的模型调用）。与核心 Agent 共用同一套类型化的
 * `AgentMessage[]` 消息形状，保证代码库里只有一种消息表示。
 *
 * 多轮工具调用请改用 `core/` 里有状态的 `Agent` 类——两边用的是同一套类型。
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";

export type StreamDeltaHandler = (delta: string) => Promise<void> | void;

/**
 * 简单 chat 调用的返回结果。对应完整 provider 流产生的 AssistantMessage，
 * 只投影出非 agentic 调用方实际需要的少量字段。
 */
export interface ChatResponse {
  /** 助手 TextContent 块拼接后的文本内容。 */
  content: string;
  /** 完整的助手消息——便于调用方读取 usage 等信息。 */
  message: AssistantMessage;
}

export interface LLMChatClient {
  name: string;
  model: string;
  chat(input: {
    /** 可选系统提示；等价于 AgentContext.systemPrompt。 */
    system?: string;
    messages: AgentMessage[];
    onDelta?: StreamDeltaHandler | null;
  }): Promise<ChatResponse>;
}
