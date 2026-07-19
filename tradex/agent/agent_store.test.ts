import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentStore, DEFAULT_AGENT_ID } from "./agent_store.js";

const dirs: string[] = [];

function tempAgentsDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tradex-agents-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("AgentStore", () => {
  it("always exposes the built-in Default Agent before local setup", () => {
    const store = new AgentStore(tempAgentsDir());

    expect(store.list()).toEqual([expect.objectContaining({
      id: DEFAULT_AGENT_ID,
      name: "Default Agent",
      runtime: "pi",
      builtIn: true,
    })]);
  });

  it("creates, updates, and removes one Agent per JSON file", () => {
    const dir = tempAgentsDir();
    const store = new AgentStore(dir);
    const created = store.create({
      id: "price-action",
      name: "价格行为分析",
      description: "分析裸 K 与市场结构",
      systemPrompt: "只使用价格行为分析。",
      runtime: "pi",
      provider: "openai",
      model: "gpt-5.4",
      reasoningEffort: null,
    });

    expect(fs.existsSync(path.join(dir, "price-action.json"))).toBe(true);
    expect(store.update(created.id, { name: "价格行为分析师" }).name).toBe("价格行为分析师");
    store.remove(created.id, () => false);
    expect(store.get(created.id)).toBeNull();
  });

  it("requires provider and model when creating a Pi Agent", () => {
    const store = new AgentStore(tempAgentsDir());
    expect(() => store.create({
      id: "missing-routing",
      name: "Missing",
      description: "",
      systemPrompt: null,
      runtime: "pi",
      provider: null,
      model: null,
      reasoningEffort: null,
    })).toThrow("Pi Agent provider is required at create time");
  });

  it("binds provider/model once and then rejects changes", () => {
    const store = new AgentStore(tempAgentsDir());
    expect(store.update(DEFAULT_AGENT_ID, { provider: "openai", model: "gpt-5.4" })).toMatchObject({
      provider: "openai",
      model: "gpt-5.4",
    });
    expect(store.update(DEFAULT_AGENT_ID, { provider: "openai", model: "gpt-5.4" })).toMatchObject({
      provider: "openai",
      model: "gpt-5.4",
    });
    expect(() => store.update(DEFAULT_AGENT_ID, { provider: "anthropic" })).toThrow(
      "Agent provider cannot be changed after it has been set",
    );
    expect(() => store.update(DEFAULT_AGENT_ID, { model: "other" })).toThrow(
      "Agent model cannot be changed after it has been set",
    );
  });

  it("protects the Default Agent and Agents with persisted Sessions", () => {
    const store = new AgentStore(tempAgentsDir());
    store.create({
      id: "ict",
      name: "ICT 分析",
      description: "ICT",
      systemPrompt: "ICT",
      runtime: "pi",
      provider: "openai",
      model: "gpt-5.4",
      reasoningEffort: null,
    });

    expect(() => store.remove(DEFAULT_AGENT_ID, () => false)).toThrow("Default Agent cannot be removed");
    expect(() => store.remove("ict", () => true)).toThrow("Agent has persisted Sessions");
    expect(() => store.update(DEFAULT_AGENT_ID, { runtime: "claude-code" })).toThrow("Default Agent must use the Pi runtime");
  });

  it("validates Claude Code effort while allowing custom model ids", () => {
    const store = new AgentStore(tempAgentsDir());
    expect(store.create({
      id: "claude-reader",
      name: "Claude Reader",
      description: "Local Claude",
      systemPrompt: null,
      runtime: "claude-code",
      provider: null,
      model: "private-claude-model",
      reasoningEffort: "high",
    })).toMatchObject({ model: "private-claude-model", reasoningEffort: "high" });

    expect(() => store.create({
      id: "bad-claude",
      name: "Bad Claude",
      description: "Invalid effort",
      systemPrompt: null,
      runtime: "claude-code",
      provider: null,
      model: "sonnet",
      reasoningEffort: "ultra",
    })).toThrow("reasoningEffort is not supported");
  });

  it("locks Claude model after the first bind", () => {
    const store = new AgentStore(tempAgentsDir());
    const created = store.create({
      id: "claude-locked",
      name: "Claude Locked",
      description: "",
      systemPrompt: null,
      runtime: "claude-code",
      provider: null,
      model: null,
      reasoningEffort: "high",
    });
    expect(store.update(created.id, { model: "opus" }).model).toBe("opus");
    expect(() => store.update(created.id, { model: "sonnet" })).toThrow(
      "Agent model cannot be changed after it has been set",
    );
  });
});
