import Anthropic from "@anthropic-ai/sdk";
import { AgentConfig, ProviderProfile } from "../../config/index.js";
import { AgentModelProfile } from "../../config/agent_models.js";
import { ChatResponse } from "../loop.js";
import { ToolCall } from "../tools/registry.js";

export class AnthropicProvider {
  readonly name = "anthropic";
  readonly model: string;
  private readonly apiKey: string;
  private readonly baseURL: string | undefined;

  constructor(config: AgentConfig, profile: AgentModelProfile) {
    this.model = profile.model;
    const providerProfile = config.providerProfiles.anthropic as ProviderProfile | undefined;
    this.apiKey = providerProfile?.apiKey || process.env.ANTHROPIC_API_KEY || "";
    this.baseURL = providerProfile?.baseUrl || process.env.ANTHROPIC_BASE_URL || undefined;
    if (!this.apiKey) throw new Error("ANTHROPIC_API_KEY is required");
  }

  async chat(input: { messages: Array<Record<string, unknown>>; tools?: Array<Record<string, unknown>> | null; onDelta?: ((delta: string) => void | Promise<void>) | null }): Promise<ChatResponse> {
    const client = new Anthropic({ apiKey: this.apiKey, baseURL: this.baseURL });
    const { system, messages } = messagesToAnthropic(input.messages);
    const stream = client.messages.stream({
      model: this.model,
      max_tokens: Number(process.env.ANTHROPIC_MAX_TOKENS || 4096),
      system,
      messages,
      tools: (input.tools ?? []).map((tool) => {
        const fn = (tool.function || {}) as Record<string, unknown>;
        return { name: String(fn.name), description: String(fn.description || ""), input_schema: (fn.parameters || {}) as never };
      }),
    } as never);
    let content = "";
    for await (const event of stream) {
      if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
        content += event.delta.text;
        await input.onDelta?.(event.delta.text);
      }
    }
    const final = await stream.finalMessage();
    const toolCalls: ToolCall[] = [];
    for (const block of final.content) {
      if (block.type === "tool_use") toolCalls.push({ id: block.id, name: block.name, arguments: (block.input || {}) as Record<string, unknown> });
    }
    return {
      content: content || final.content.filter((b) => b.type === "text").map((b) => b.text).join(""),
      toolCalls,
      finishReason: final.stop_reason || "stop",
      usage: { prompt_tokens: final.usage.input_tokens, completion_tokens: final.usage.output_tokens, total_tokens: final.usage.input_tokens + final.usage.output_tokens },
    };
  }

  async listModels(): Promise<Array<Record<string, unknown>>> {
    return [{ id: this.model, provider: this.name, label: this.model }];
  }
}

function messagesToAnthropic(messages: Array<Record<string, unknown>>): { system: string; messages: Array<Record<string, unknown>> } {
  const systemParts: string[] = [];
  const output: Array<Record<string, unknown>> = [];
  for (const msg of messages) {
    const role = String(msg.role || "");
    if (role === "system") systemParts.push(String(msg.content || ""));
    else if (role === "user" || role === "assistant") output.push({ role, content: String(msg.content || "") });
    else if (role === "tool") output.push({ role: "user", content: `Tool ${String(msg.name || "")} returned:\n${String(msg.content || "")}` });
  }
  return { system: systemParts.join("\n\n"), messages: output };
}
