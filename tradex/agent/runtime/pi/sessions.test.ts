import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_AGENT_ID } from "../../agent_store.js";
import {
  appendAgentSnapshot,
  createPiSession,
  piSessionPayload,
  readAgentSnapshot,
  piSessionFileExists,
} from "./sessions.js";

const dirs: string[] = [];
function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tradex-session-agent-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => dirs.splice(0).forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));

describe("Session Agent snapshot", () => {
  it("projects legacy Sessions as belonging to the Default Agent", () => {
    const manager = createPiSession({ sessionDir: tempDir() });

    expect(readAgentSnapshot(manager).agentId).toBe(DEFAULT_AGENT_ID);
    expect((piSessionPayload(manager).session as { agentId: string }).agentId).toBe(DEFAULT_AGENT_ID);
  });

  it("persists and restores the selected Agent configuration", () => {
    const manager = createPiSession({ sessionDir: tempDir() });
    appendAgentSnapshot(manager, {
      agentId: "ict",
      agentName: "ICT 理论分析",
      runtime: "pi",
      systemPrompt: "ICT prompt",
      provider: "codex",
      model: "gpt-5.4",
      reasoningEffort: "high",
    });
    appendAgentSnapshot(manager, {
      agentId: "other", agentName: "Other", runtime: "pi", systemPrompt: "changed",
      provider: "openai", model: "other", reasoningEffort: "low",
    });

    expect(piSessionFileExists(manager)).toBe(false);
    expect(readAgentSnapshot(manager)).toEqual({
      agentId: "ict",
      agentName: "ICT 理论分析",
      runtime: "pi",
      systemPrompt: "ICT prompt",
      provider: "codex",
      model: "gpt-5.4",
      reasoningEffort: "high",
    });
    expect((piSessionPayload(manager).session as { agentId: string }).agentId).toBe("ict");
  });
});
