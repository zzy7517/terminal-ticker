/**
 * registry.ts — AgentModel 解析 + 远程模型目录拉取的便捷封装。
 *
 * 使用方：
 *  - api/routes/agent.ts 的 listAvailableModels()
 *  - memory pipeline（经 LLMProviderFactory）
 */

import { AgentConfig } from "../../../../config/index.js";
import {
  ANTHROPIC_PROVIDER,
  CODEX_PROVIDER,
} from "./constants.js";
import type { LLMChatClient, ChatResponse } from "../../../llm_client.js";
import type { AgentModel } from "./resolve.js";
import { resolveAgentModelFromConfig } from "./resolve.js";
import { convertToLlm } from "@earendil-works/pi-coding-agent";
import { streamSimple } from "@earendil-works/pi-ai/compat";
import type { TextContent } from "@earendil-works/pi-ai";
import type { ModelRuntimeSnapshot } from "./runtime.js";
import { fetchProviderModelCatalog } from "./model_fetch.js";

export class LLMProviderUnavailable extends Error {}

/**
 * AgentModelRegistry — 把 config 解析成 AgentModel，
 * 并为 memory pipeline 提供简单的 chat 客户端。
 */
export class AgentModelRegistry {
  constructor(private readonly modelRuntime: ModelRuntimeSnapshot) {}

  /** 把 config 解析成 AgentModel 值对象。 */
  resolve(config: AgentConfig): AgentModel {
    return resolveAgentModelFromConfig(config);
  }

  /**
   * 根据 config 创建 LLMChatClient。
   * 把 provider 流式接口包成轻量 chat 接口，供 memory pipeline 等非 agentic 调用方使用。
   */
  createProvider(config: AgentConfig): LLMChatClient {
    const { model, modelRegistry, requiresAuth } = this.modelRuntime.resolve(config);
    return {
      name: model.provider,
      model: model.id,
      async chat({ system, messages, onDelta }): Promise<ChatResponse> {
        const auth = await modelRegistry.getApiKeyAndHeaders(model);
        if (!auth.ok) throw new LLMProviderUnavailable(auth.error);
        const stream = streamSimple(model, {
          systemPrompt: system ?? "",
          messages: convertToLlm(messages),
          tools: [],
        }, {
          apiKey: auth.apiKey,
          headers: requiresAuth
            ? auth.headers
            : {
                ...auth.headers,
                Authorization: null as unknown as string,
              },
        });
        // 在等待最终结果的同时，把文本 delta 转发给旧的 onDelta 回调
        if (onDelta) {
          for await (const evt of stream) {
            if (evt.type === "text_delta" && evt.delta) {
              onDelta(evt.delta);
            }
          }
        }
        const message = await stream.result();
        const content = message.content
          .filter((c): c is TextContent => c.type === "text")
          .map((c) => c.text)
          .join("");
        return { content, message };
      },
    };
  }

  /** 从 provider 的远程目录拉取可用模型列表。 */
  async listAvailableModels(
    config: AgentConfig,
    providerOverride?: string | null,
  ): Promise<Array<Record<string, unknown>>> {
    return fetchProviderModelCatalog(config, providerOverride);
  }
}

// 再导出已支持的 provider 常量，调用方不必从 config 导入也能知道注册了哪些。
export { ANTHROPIC_PROVIDER, CODEX_PROVIDER };
