// 验证 Pi SDK 事件到统一 Runtime 事件的转换行为。
import { describe, expect, it } from "vitest";
import type { AgentEvent } from "@earendil-works/pi-agent-core";
import { piEventToRuntimeEvents, piMessageToRuntimeMessage } from "./events.js";

const assistant = {
  role: "assistant" as const,
  content: [
    { type: "text" as const, text: "Done" },
    { type: "toolCall" as const, id: "call-1", name: "chart", arguments: { symbol: "BTC" } },
  ],
  api: "openai-responses" as const,
  provider: "openai",
  model: "gpt-test",
  usage: {
    input: 10,
    output: 4,
    cacheRead: 2,
    cacheWrite: 1,
    totalTokens: 17,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.25 },
  },
  stopReason: "stop" as const,
  timestamp: 123,
};

describe("Pi Runtime event adapter", () => {
  it("preserves assistant usage, tool calls, and stable identity", () => {
    const first = piMessageToRuntimeMessage(assistant);
    const second = piMessageToRuntimeMessage(assistant);

    expect(first.id).toBe(second.id);
    expect(first.content).toContainEqual({ type: "toolCall", id: "call-1", name: "chart", arguments: { symbol: "BTC" } });
    expect(first.usage).toEqual({ model: "gpt-test", input: 10, output: 4, cacheRead: 2, cacheWrite: 1, total: 17 });
  });

  it("preserves structured tool results including images, details, and terminate", () => {
    const event = {
      type: "tool_execution_end",
      toolCallId: "call-1",
      toolName: "chart",
      result: {
        content: [
          { type: "text", text: "chart ready" },
          { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
        ],
        details: { source: "cache" },
        terminate: true,
      },
      isError: false,
    } as AgentEvent;

    expect(piEventToRuntimeEvents(event, "turn:1")).toEqual([{
      type: "tool-result",
      callId: "call-1",
      name: "chart",
      result: {
        content: [
          { type: "text", text: "chart ready" },
          { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
        ],
        details: { source: "cache" },
        terminate: true,
      },
      isError: false,
    }]);
  });
});
