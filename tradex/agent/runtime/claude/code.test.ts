import { describe, expect, it } from "vitest";
import { buildClaudeArgs, classifyClaudeError, parseClaudeLine, windowsTaskkillArgs } from "./code.js";

describe("Claude Code runtime protocol", () => {
  it("builds a controlled headless invocation without overriding local defaults", () => {
    expect(buildClaudeArgs({
      prompt: "Analyze BTC",
      instructions: "Use Tradex tools.",
      mcpConfigPath: "/tmp/tradex-mcp.json",
      allowedMcpTools: ["get_market_context", "get_recent_news"],
    })).toEqual([
      "-p",
      "--verbose",
      "--output-format", "stream-json",
      "--include-partial-messages",
      "--permission-mode", "dontAsk",
      "--strict-mcp-config",
      "--mcp-config", "/tmp/tradex-mcp.json",
      "--append-system-prompt", "Use Tradex tools.",
      "--tools", "mcp__tradex__get_market_context,mcp__tradex__get_recent_news",
      "--allowedTools", "mcp__tradex__get_market_context,mcp__tradex__get_recent_news",
      "Analyze BTC",
    ]);
  });

  it("adds resume, model, and effort only when explicitly configured", () => {
    const args = buildClaudeArgs({
      prompt: "Continue",
      instructions: "Rules",
      mcpConfigPath: "/tmp/mcp.json",
      allowedMcpTools: [],
      nativeSessionId: "11111111-1111-4111-8111-111111111111",
      model: "opus",
      effort: "high",
    });
    expect(args.slice(args.indexOf("--resume"), args.indexOf("--resume") + 2)).toEqual(["--resume", "11111111-1111-4111-8111-111111111111"]);
    expect(args.slice(args.indexOf("--model"), args.indexOf("--model") + 2)).toEqual(["--model", "opus"]);
    expect(args.slice(args.indexOf("--effort"), args.indexOf("--effort") + 2)).toEqual(["--effort", "high"]);
  });

  it("projects assistant text, tool calls, results, and native session identity", () => {
    expect(parseClaudeLine(JSON.stringify({
      type: "system",
      subtype: "init",
      session_id: "11111111-1111-4111-8111-111111111111",
    }))).toEqual([{ type: "run-start", nativeSessionId: "11111111-1111-4111-8111-111111111111" }]);

    expect(parseClaudeLine(JSON.stringify({
      type: "assistant",
      message: {
        role: "assistant",
        model: "claude-sonnet",
        content: [
          { type: "text", text: "BTC is firm." },
          { type: "tool_use", id: "call-1", name: "mcp__tradex__get_market_context", input: { symbol: "BTC" } },
        ],
        usage: { input_tokens: 12, output_tokens: 4, cache_read_input_tokens: 3, cache_creation_input_tokens: 0 },
      },
    }))).toEqual([
      { type: "text-delta", delta: "BTC is firm." },
      { type: "tool-start", callId: "call-1", name: "get_market_context", args: { symbol: "BTC" } },
      { type: "usage", model: "claude-sonnet", input: 12, output: 4, cacheRead: 3, cacheWrite: 0 },
    ]);

    expect(parseClaudeLine(JSON.stringify({
      type: "user",
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "call-1", content: "ok", is_error: false }] },
    }))).toEqual([{ type: "tool-end", callId: "call-1", output: "ok", isError: false }]);
  });

  it("projects Claude stream_event text deltas", () => {
    expect(parseClaudeLine(JSON.stringify({
      type: "stream_event",
      event: { type: "content_block_delta", delta: { type: "text_delta", text: "live" } },
    }))).toEqual([{ type: "text-delta", delta: "live" }]);
  });

  it("classifies malformed protocol lines instead of silently dropping them", () => {
    expect(parseClaudeLine("not-json")).toEqual([{
      type: "runtime-error",
      code: "malformed_stream_json",
      message: "Claude Code emitted malformed stream-json",
    }]);
    expect(parseClaudeLine(JSON.stringify({ type: "system" }))).toEqual([{
      type: "runtime-error",
      code: "invalid_system_event",
      message: "Claude Code system event is missing session_id",
    }]);
    expect(parseClaudeLine(JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "tool_use", name: "missing-id" }] },
    }))).toEqual([{
      type: "runtime-error",
      code: "invalid_tool_use",
      message: "Claude Code tool_use block is missing id or name",
    }]);
  });

  it("classifies common Claude runtime failures", () => {
    expect(classifyClaudeError("Please run claude login")).toBe("auth_required");
    expect(classifyClaudeError("Model is not available for this account")).toBe("model_unavailable");
    expect(classifyClaudeError("MCP connection refused")).toBe("mcp_connection_failed");
    expect(classifyClaudeError("Permission denied")).toBe("permission_denied");
  });

  it("builds shell-free Windows process-tree termination arguments", () => {
    expect(windowsTaskkillArgs(123, false)).toEqual(["/PID", "123", "/T"]);
    expect(windowsTaskkillArgs(123, true)).toEqual(["/PID", "123", "/T", "/F"]);
  });
});
