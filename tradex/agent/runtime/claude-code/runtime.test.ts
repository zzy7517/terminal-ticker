import { describe, expect, it } from "vitest";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ToolRegistry } from "../../tools/registry.js";
import { McpRunGrantStore } from "../../../mcp/server/grants.js";
import {
  buildClaudeArgs,
  classifyClaudeError,
  ClaudeCodeRuntime,
  parseClaudeLine,
  purgeClaudeProject,
  windowsTaskkillArgs,
} from "./runtime.js";

describe("Claude Code runtime protocol", () => {
  it("builds a controlled headless invocation without loading filesystem settings", () => {
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
      "--setting-sources", "",
      "--strict-mcp-config",
      "--mcp-config", "/tmp/tradex-mcp.json",
      "--system-prompt", "Use Tradex tools.",
      "--tools", "Read,Bash,mcp__tradex__get_market_context,mcp__tradex__get_recent_news",
      "--allowedTools", "Read,Bash,mcp__tradex__get_market_context,mcp__tradex__get_recent_news",
      "--", "Analyze BTC",
    ]);
  });

  it("keeps option-like prompts behind the argument separator", () => {
    const args = buildClaudeArgs({
      prompt: "--version",
      instructions: "Rules",
      mcpConfigPath: "/tmp/mcp.json",
      allowedMcpTools: [],
    });

    expect(args.slice(-2)).toEqual(["--", "--version"]);
  });

  it("keeps native Read and Bash available when no Tradex Tools are exposed through MCP", () => {
    const args = buildClaudeArgs({
      prompt: "Inspect attachments/image.png",
      instructions: "Read the attached image.",
      mcpConfigPath: "/tmp/mcp.json",
      allowedMcpTools: [],
    });
    expect(args.slice(args.indexOf("--tools"), args.indexOf("--tools") + 2)).toEqual(["--tools", "Read,Bash"]);
    expect(args.slice(args.indexOf("--allowedTools"), args.indexOf("--allowedTools") + 2)).toEqual(["--allowedTools", "Read,Bash"]);
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
      {
        type: "message-update",
        message: {
          id: "claude:assistant",
          role: "assistant",
          content: [{ type: "text", text: "BTC is firm." }],
          timestamp: expect.any(Number),
          usage: { model: "claude-sonnet", input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        delta: "BTC is firm.",
      },
      { type: "tool-start", callId: "call-1", name: "get_market_context", args: { symbol: "BTC" } },
      { type: "usage", model: "claude-sonnet", input: 12, output: 4, cacheRead: 3, cacheWrite: 0 },
    ]);

    expect(parseClaudeLine(JSON.stringify({
      type: "user",
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "call-1", content: "ok", is_error: false }] },
    }))).toEqual([{
      type: "tool-result",
      callId: "call-1",
      name: "unknown",
      result: { content: [{ type: "text", text: "ok" }] },
      isError: false,
    }]);
  });

  it("projects Claude stream_event text deltas", () => {
    expect(parseClaudeLine(JSON.stringify({
      type: "stream_event",
      event: { type: "content_block_delta", delta: { type: "text_delta", text: "live" } },
    }))).toEqual([{
      type: "message-update",
      message: { id: "claude:assistant", role: "assistant", content: [], timestamp: expect.any(Number) },
      delta: "live",
    }]);
  });

  it("projects failed result events that do not contain a result string", () => {
    expect(parseClaudeLine(JSON.stringify({
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
      errors: ["Authentication failed"],
      terminal_reason: "aborted_streaming",
      session_id: "11111111-1111-4111-8111-111111111111",
    }))).toEqual([{
      type: "run-end",
      nativeSessionId: "11111111-1111-4111-8111-111111111111",
      result: "Authentication failed",
      status: "error",
    }]);
  });

  it("summarizes non-text tool results without retaining image data", () => {
    const events = parseClaudeLine(JSON.stringify({
      type: "user",
      message: {
        content: [{
          type: "tool_result",
          tool_use_id: "call-1",
          content: [
            { type: "text", text: "Chart captured" },
            { type: "image", source: { type: "base64", media_type: "image/png", data: "large-base64-payload" } },
          ],
        }],
      },
    }));

    expect(events).toEqual([{
      type: "tool-result",
      callId: "call-1",
      name: "unknown",
      result: { content: [{ type: "text", text: "Chart captured\n[image]" }] },
      isError: false,
    }]);
    expect(JSON.stringify(events)).not.toContain("large-base64-payload");
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

describe("Claude Code child process", () => {
  it("streams events and returns the native session id", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "tradex-claude-"));
    const executable = path.join(cwd, "fake-claude.mjs");
    await writeFile(executable, `#!/usr/bin/env node
console.log(JSON.stringify({type:"system",subtype:"init",session_id:"11111111-1111-4111-8111-111111111111"}));
console.log(JSON.stringify({type:"stream_event",event:{type:"content_block_delta",delta:{type:"text_delta",text:"done"}}}));
console.log(JSON.stringify({type:"assistant",message:{role:"assistant",model:"claude",content:[{type:"text",text:"done"}]}}));
console.log(JSON.stringify({type:"result",session_id:"11111111-1111-4111-8111-111111111111",result:"done",is_error:false}));
`);
    await chmod(executable, 0o755);
    const runtime = new ClaudeCodeRuntime({ executablePath: executable, mcpUrl: "http://127.0.0.1/mcp/tradex", grants: new McpRunGrantStore() });
    const run = await runtime.start({ tradexSessionId: "s1", cwd, prompt: "go", instructions: "rules", registry: new ToolRegistry() });
    const events: string[] = [];
    run.subscribe((event) => { events.push(event.type); });
    const result = await run.result;
    expect(events).toEqual(["run-start", "message-update", "run-end"]);
    expect(result).toMatchObject({ output: "done", nativeSessionId: "11111111-1111-4111-8111-111111111111", error: null });
  });

  it("replays protocol events emitted before the first subscriber attaches", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "tradex-claude-"));
    const executable = path.join(cwd, "fake-claude.mjs");
    await writeFile(executable, `#!/usr/bin/env node
console.log(JSON.stringify({type:"system",session_id:"11111111-1111-4111-8111-111111111111"}));
console.log(JSON.stringify({type:"assistant",message:{model:"claude",content:[{type:"text",text:"fast"}]}}));
console.log(JSON.stringify({type:"result",result:"fast",is_error:false}));
`);
    await chmod(executable, 0o755);
    const runtime = new ClaudeCodeRuntime({ executablePath: executable, mcpUrl: "http://127.0.0.1/mcp/tradex", grants: new McpRunGrantStore() });
    const run = await runtime.start({ tradexSessionId: "s1", cwd, prompt: "go", instructions: "rules", registry: new ToolRegistry() });
    await new Promise((resolve) => setTimeout(resolve, 100));
    const events: string[] = [];
    run.subscribe((event) => { events.push(event.type); });
    await run.result;
    expect(events).toEqual(["run-start", "message-update", "run-end"]);
  });

  it("fails closed when the stream ends without a terminal result", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "tradex-claude-"));
    const executable = path.join(cwd, "fake-claude.mjs");
    await writeFile(executable, `#!/usr/bin/env node
const session = "11111111-1111-4111-8111-111111111111";
console.log(JSON.stringify({ type: "system", subtype: "init", session_id: session }));
console.log(JSON.stringify({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "partial" } } }));
`);
    await chmod(executable, 0o755);
    const runtime = new ClaudeCodeRuntime({
      executablePath: executable,
      mcpUrl: "http://127.0.0.1/mcp/tradex",
      grants: new McpRunGrantStore(),
    });
    const run = await runtime.start({
      tradexSessionId: "s1",
      cwd,
      prompt: "go",
      instructions: "rules",
      registry: new ToolRegistry(),
      nativeSessionId: "11111111-1111-4111-8111-111111111111",
    });
    const runEnds: Array<{ status: string; result: string }> = [];
    run.subscribe((event) => {
      if (event.type === "run-end") runEnds.push({ status: event.status, result: event.result });
    });

    const result = await run.result;

    expect(result).toMatchObject({
      output: "",
      nativeSessionId: "11111111-1111-4111-8111-111111111111",
      error: "Claude Code stream ended without terminal result",
      errorCode: "missing_terminal_result",
    });
    expect(runEnds).toEqual([{
      status: "error",
      result: "Claude Code stream ended without terminal result",
    }]);
  });

  it("stops an inactive Claude process and classifies the timeout", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "tradex-claude-"));
    const executable = path.join(cwd, "fake-claude.mjs");
    await writeFile(executable, "#!/usr/bin/env node\nsetInterval(() => {}, 1000);\n");
    await chmod(executable, 0o755);
    const runtime = new ClaudeCodeRuntime({
      executablePath: executable,
      mcpUrl: "http://127.0.0.1/mcp/tradex",
      grants: new McpRunGrantStore(),
      runTimeoutMs: 2_000,
      inactivityTimeoutMs: 50,
    });
    const run = await runtime.start({ tradexSessionId: "s1", cwd, prompt: "go", instructions: "rules", registry: new ToolRegistry() });

    await expect(run.result).resolves.toMatchObject({
      errorCode: "inactivity_timeout",
      error: expect.stringContaining("inactive"),
    });
  });

  it("revokes the MCP grant when start fails before the run begins", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "tradex-claude-"));
    const grants = new McpRunGrantStore();
    const issue = grants.issue.bind(grants);
    let token = "";
    grants.issue = ((input) => {
      const issued = issue(input);
      token = issued.token;
      return issued;
    }) as typeof grants.issue;
    const runtime = new ClaudeCodeRuntime({
      executablePath: "claude",
      mcpUrl: "http://127.0.0.1/mcp/tradex",
      grants,
    });
    let listCalls = 0;
    const registry = {
      listToolsForExternalMcp() {
        listCalls += 1;
        // issue() 会先列出一次工具；第二次发生在写完 mcp 配置之后，用来模拟启动中段失败。
        if (listCalls === 1) return [];
        throw new Error("tool policy boom");
      },
    } as unknown as ToolRegistry;

    await expect(runtime.start({
      tradexSessionId: "s1",
      cwd,
      prompt: "go",
      instructions: "rules",
      registry,
    })).rejects.toThrow("tool policy boom");

    expect(token).not.toBe("");
    expect(grants.resolve(token)).toBeNull();
  });
});

describe("Claude Code project purge", () => {
  it("uses the native project purge command with the exact Session directory", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "tradex-claude-purge-"));
    const executable = path.join(directory, "fake-claude.mjs");
    const output = path.join(directory, "argv.json");
    await writeFile(executable, `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(output)}, JSON.stringify(process.argv.slice(2)));
`);
    await chmod(executable, 0o755);

    await purgeClaudeProject(executable, path.join(directory, "session"));

    await expect(readFile(output, "utf8").then(JSON.parse)).resolves.toEqual([
      "project", "purge", path.join(directory, "session"), "--yes",
    ]);
  });

  it("rejects when Claude refuses the purge", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "tradex-claude-purge-"));
    const executable = path.join(directory, "fake-claude.mjs");
    await writeFile(executable, "#!/usr/bin/env node\nprocess.stderr.write('cannot purge'); process.exit(7);\n");
    await chmod(executable, 0o755);

    await expect(purgeClaudeProject(executable, directory)).rejects.toThrow("cannot purge");
  });

  it("treats missing project state as an idempotent success", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "tradex-claude-purge-"));
    const executable = path.join(directory, "fake-claude.mjs");
    await writeFile(executable, "#!/usr/bin/env node\nprocess.stderr.write('No project state found'); process.exit(1);\n");
    await chmod(executable, 0o755);

    await expect(purgeClaudeProject(executable, directory)).resolves.toBeUndefined();
  });
});
