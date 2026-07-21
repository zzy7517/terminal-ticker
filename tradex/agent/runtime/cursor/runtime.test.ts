import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ToolRegistry } from "../../tools/registry.js";
import { McpRunGrantStore } from "../../../mcp/server/grants.js";
import {
  buildCursorArgs,
  composeCursorPrompt,
  CursorCliRuntime,
} from "./runtime.js";
import {
  classifyCursorError,
  parseCursorLine,
} from "./protocol.js";
import { fetchCursorModelCatalog, parseCursorModelList } from "./model-catalog.js";

describe("Cursor CLI runtime protocol", () => {
  it("builds a controlled headless invocation with workspace and approvals", () => {
    expect(buildCursorArgs({
      prompt: "Analyze BTC",
      instructions: "Use Tradex tools.",
      workspace: "/tmp/cursor-session",
      nativeSessionId: "11111111-1111-4111-8111-111111111111",
      model: "composer-2.5",
      sandbox: "disabled",
    })).toEqual([
      "-p",
      "--force",
      "--trust",
      "--approve-mcps",
      "--output-format", "stream-json",
      "--stream-partial-output",
      "--workspace", "/tmp/cursor-session",
      "--resume", "11111111-1111-4111-8111-111111111111",
      "--model", "composer-2.5",
      "--sandbox", "disabled",
      "Use Tradex tools.\n\n---\n\nAnalyze BTC",
    ]);
  });

  it("prepends instructions to the prompt", () => {
    expect(composeCursorPrompt("Rules", "Do work")).toBe("Rules\n\n---\n\nDo work");
    expect(composeCursorPrompt("", "Do work")).toBe("Do work");
  });

  it("projects system init, assistant text, tool calls, and result", () => {
    expect(parseCursorLine(JSON.stringify({
      type: "system",
      subtype: "init",
      session_id: "11111111-1111-4111-8111-111111111111",
    }))).toEqual([{ type: "run-start", nativeSessionId: "11111111-1111-4111-8111-111111111111" }]);

    expect(parseCursorLine(JSON.stringify({
      type: "assistant",
      timestamp_ms: 1,
      message: { role: "assistant", content: [{ type: "text", text: "hello" }] },
      session_id: "11111111-1111-4111-8111-111111111111",
    }))[0]).toMatchObject({ type: "message-update", delta: "hello" });

    expect(parseCursorLine(JSON.stringify({
      type: "tool_call",
      subtype: "started",
      call_id: "call-1",
      tool_call: { readToolCall: { args: { path: "a.ts" } } },
    }))).toEqual([{
      type: "tool-start",
      callId: "call-1",
      name: "read",
      args: { path: "a.ts" },
    }]);

    expect(parseCursorLine(JSON.stringify({
      type: "tool_call",
      subtype: "started",
      call_id: "call-2",
      tool_call: { function: { name: "get_quote", arguments: "{\"symbol\":\"BTCUSDT\"}" } },
    }))).toEqual([{
      type: "tool-start",
      callId: "call-2",
      name: "get_quote",
      args: { symbol: "BTCUSDT" },
    }]);

    expect(parseCursorLine(JSON.stringify({
      type: "result",
      session_id: "11111111-1111-4111-8111-111111111111",
      result: "done",
    }))).toEqual([{
      type: "run-end",
      nativeSessionId: "11111111-1111-4111-8111-111111111111",
      result: "done",
      status: "completed",
    }]);
  });

  it("uses only partial assistant deltas and skips duplicate flush events", () => {
    const message = { role: "assistant", content: [{ type: "text", text: "hello" }] };
    expect(parseCursorLine(JSON.stringify({ type: "assistant", timestamp_ms: 1, message }))).toHaveLength(1);
    expect(parseCursorLine(JSON.stringify({ type: "assistant", timestamp_ms: 1, model_call_id: "m1", message }))).toEqual([]);
    expect(parseCursorLine(JSON.stringify({ type: "assistant", message }))).toEqual([]);
  });

  it("preserves identical consecutive partial deltas", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "tradex-cursor-runtime-"));
    const executable = path.join(cwd, "fake-cursor.mjs");
    await writeFile(executable, `#!/usr/bin/env node
const session = "11111111-1111-4111-8111-111111111111";
console.log(JSON.stringify({ type: "system", subtype: "init", session_id: session }));
console.log(JSON.stringify({ type: "assistant", timestamp_ms: 1, message: { role: "assistant", content: [{ type: "text", text: "ha" }] } }));
console.log(JSON.stringify({ type: "assistant", timestamp_ms: 2, message: { role: "assistant", content: [{ type: "text", text: "ha" }] } }));
console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "haha", session_id: session }));
`);
    await chmod(executable, 0o755);
    const run = await new CursorCliRuntime({
      executablePath: executable,
      mcpUrl: "http://127.0.0.1/mcp/tradex",
      grants: new McpRunGrantStore(),
    }).start({
      tradexSessionId: "tradex-session",
      cwd,
      prompt: "go",
      instructions: "rules",
      registry: new ToolRegistry(),
      nativeSessionId: "11111111-1111-4111-8111-111111111111",
    });
    const deltas: string[] = [];
    run.subscribe((event) => {
      if (event.type === "message-update") deltas.push(event.delta);
    });

    const result = await run.result;

    expect(deltas).toEqual(["ha", "ha"]);
    expect(result.output).toBe("haha");
  });

  it("classifies auth and resume failures", () => {
    expect(classifyCursorError("Please login with API key")).toBe("auth_required");
    expect(classifyCursorError("chat session not found")).toBe("native_session_resume_failed");
  });

  it("parses --list-models output", () => {
    const models = parseCursorModelList([
      "Available models",
      "auto - Auto (default)",
      "composer-2.5 - Composer 2.5",
    ].join("\n"));
    expect(models[0]).toMatchObject({ id: "auto", default: true });
    expect(models[1]).toMatchObject({ id: "composer-2.5", label: "Composer 2.5" });
  });

  it("reports model discovery failures instead of presenting fallback models as live", async () => {
    const result = await fetchCursorModelCatalog("/missing/tradex-cursor-agent");

    expect(result.models[0]).toMatchObject({ id: "auto", default: true });
    expect(result.error).toMatch(/ENOENT|not found/i);
  });
});
