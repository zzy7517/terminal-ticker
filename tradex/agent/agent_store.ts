/** 将可复用 Agent 定义保存为经过校验的 JSON 文件。 */
import fs from "node:fs";
import path from "node:path";
import { isClaudeThinkingLevel } from "./runtime/claude-code/model-manifest.js";

export const DEFAULT_AGENT_ID = "default";

export interface AgentDefinition {
  id: string;
  name: string;
  description: string;
  systemPrompt: string | null;
  runtime: "pi" | "claude-code";
  provider: string | null;
  model: string | null;
  reasoningEffort: string | null;
  builtIn: boolean;
}

export type AgentFileInput = Omit<AgentDefinition, "builtIn">;

const BUILT_IN_DEFAULT: AgentDefinition = {
  id: DEFAULT_AGENT_ID,
  name: "Default Agent",
  description: "Tradex built-in trading and market analysis Agent",
  systemPrompt: null,
  runtime: "pi",
  provider: null,
  model: null,
  reasoningEffort: null,
  builtIn: true,
};

export class AgentStore {
  constructor(readonly directory = path.join(process.cwd(), "agents")) {}

  list(): AgentDefinition[] {
    const local = this.readFiles();
    const defaultOverride = local.find((agent) => agent.id === DEFAULT_AGENT_ID);
    const defaultAgent = defaultOverride
      ? { ...BUILT_IN_DEFAULT, ...defaultOverride, id: DEFAULT_AGENT_ID, builtIn: true as const }
      : BUILT_IN_DEFAULT;
    return [defaultAgent, ...local.filter((agent) => agent.id !== DEFAULT_AGENT_ID).map((agent) => ({ ...agent, builtIn: false }))]
      .sort((left, right) => left.id === DEFAULT_AGENT_ID ? -1 : right.id === DEFAULT_AGENT_ID ? 1 : left.name.localeCompare(right.name));
  }

  get(id: string): AgentDefinition | null {
    return this.list().find((agent) => agent.id === id) ?? null;
  }

  create(input: AgentFileInput): AgentDefinition {
    const agent = validateAgent(input);
    if (agent.id === DEFAULT_AGENT_ID || this.get(agent.id)) throw new Error(`Agent already exists: ${agent.id}`);
    this.write(agent);
    return { ...agent, builtIn: false };
  }

  update(id: string, patch: Partial<Omit<AgentFileInput, "id">>): AgentDefinition {
    const current = this.get(id);
    if (!current) throw new Error(`Agent not found: ${id}`);
    if (id === DEFAULT_AGENT_ID && patch.runtime && patch.runtime !== "pi") {
      throw new Error("Default Agent must use the Pi runtime");
    }
    const next = validateAgent({ ...current, ...patch, id });
    this.write(next);
    return { ...next, builtIn: id === DEFAULT_AGENT_ID };
  }

  remove(id: string, hasPersistedSessions: (agentId: string) => boolean): void {
    if (id === DEFAULT_AGENT_ID) throw new Error("Default Agent cannot be removed");
    if (!this.get(id)) throw new Error(`Agent not found: ${id}`);
    if (hasPersistedSessions(id)) throw new Error("Agent has persisted Sessions");
    fs.unlinkSync(this.filePath(id));
  }

  private readFiles(): AgentFileInput[] {
    if (!fs.existsSync(this.directory)) return [];
    return fs.readdirSync(this.directory)
      .filter((name) => name.endsWith(".json"))
      .map((name) => {
        const filePath = path.join(this.directory, name);
        return validateAgent(JSON.parse(fs.readFileSync(filePath, "utf8")) as AgentFileInput, filePath);
      });
  }

  private write(agent: AgentFileInput): void {
    fs.mkdirSync(this.directory, { recursive: true });
    const target = this.filePath(agent.id);
    const temporary = `${target}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(agent, null, 2)}\n`, "utf8");
    fs.renameSync(temporary, target);
  }

  private filePath(id: string): string {
    assertAgentId(id);
    return path.join(this.directory, `${id}.json`);
  }
}

function validateAgent(value: AgentFileInput, source = "Agent"): AgentFileInput {
  if (!value || typeof value !== "object") throw new Error(`${source} must be an object`);
  assertAgentId(value.id);
  if (typeof value.name !== "string" || !value.name.trim()) throw new Error(`${source} name is required`);
  if (typeof value.description !== "string") throw new Error(`${source} description must be a string`);
  if (value.systemPrompt !== null && typeof value.systemPrompt !== "string") throw new Error(`${source} systemPrompt must be a string or null`);
  if (value.runtime !== "pi" && value.runtime !== "claude-code") throw new Error(`${source} runtime must be pi or claude-code`);
  if (value.runtime === "claude-code" && value.provider !== null) throw new Error(`${source} Claude Code provider must be null`);
  if (value.runtime === "claude-code" && !isClaudeThinkingLevel(value.reasoningEffort)) {
    throw new Error(`${source} Claude Code reasoningEffort is not supported`);
  }
  for (const key of ["provider", "model", "reasoningEffort"] as const) {
    if (value[key] !== null && typeof value[key] !== "string") throw new Error(`${source} ${key} must be a string or null`);
  }
  return {
    id: value.id,
    name: value.name.trim(),
    description: value.description.trim(),
    systemPrompt: value.systemPrompt,
    runtime: value.runtime,
    provider: value.runtime === "claude-code" ? null : value.provider?.trim() || null,
    model: value.model?.trim() || null,
    reasoningEffort: value.reasoningEffort?.trim() || null,
  };
}

function assertAgentId(id: string): void {
  if (typeof id !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id)) {
    throw new Error("Agent id must contain lowercase letters, numbers, and single hyphens");
  }
}
