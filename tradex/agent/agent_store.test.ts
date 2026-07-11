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
      provider: null,
      model: null,
      reasoningEffort: null,
    });

    expect(fs.existsSync(path.join(dir, "price-action.json"))).toBe(true);
    expect(store.update(created.id, { name: "价格行为分析师" }).name).toBe("价格行为分析师");
    store.remove(created.id, () => false);
    expect(store.get(created.id)).toBeNull();
  });

  it("protects the Default Agent and Agents with persisted Sessions", () => {
    const store = new AgentStore(tempAgentsDir());
    store.create({
      id: "ict",
      name: "ICT 分析",
      description: "ICT",
      systemPrompt: "ICT",
      runtime: "pi",
      provider: null,
      model: null,
      reasoningEffort: null,
    });

    expect(() => store.remove(DEFAULT_AGENT_ID, () => false)).toThrow("Default Agent cannot be removed");
    expect(() => store.remove("ict", () => true)).toThrow("Agent has persisted Sessions");
  });
});
