import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ToolRegistry } from "../../tools/registry.js";
import { McpRunGrantStore } from "../../../mcp/server/grants.js";
import { ClaudeCodeRuntime } from "./code.js";

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
    run.subscribe((event) => events.push(event.type));
    const result = await run.result;
    expect(events).toEqual(["run-start", "text-delta", "run-end"]);
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
    run.subscribe((event) => events.push(event.type));
    await run.result;
    expect(events).toEqual(["run-start", "text-delta", "run-end"]);
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
});
