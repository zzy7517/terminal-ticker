/** 维护 Claude Code 首方模型及其可选 effort，供 Agent 编辑器统一展示。 */
export type ClaudeEffortLevel = "low" | "medium" | "high" | "xhigh" | "max";

export interface ClaudeModelThinking {
  supportedLevels: ClaudeEffortLevel[];
  defaultLevel: ClaudeEffortLevel | null;
}

export interface ClaudeModelOption {
  id: string;
  label: string;
  provider: "anthropic";
  default?: boolean;
  thinking: ClaudeModelThinking;
}

export const CLAUDE_THINKING_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;

const EFFORT_LEVELS = {
  standard: ["low", "medium", "high", "max"],
  xhigh: CLAUDE_THINKING_LEVELS,
} as const satisfies Record<string, readonly ClaudeEffortLevel[]>;

interface ClaudeModelManifestEntry {
  id: string;
  label: string;
  default?: boolean;
  effortLevels?: readonly ClaudeEffortLevel[];
}

const CLAUDE_MODEL_MANIFEST = [
  { id: "claude-fable-5", label: "Fable 5", effortLevels: EFFORT_LEVELS.xhigh },
  { id: "claude-opus-4-8[1m]", label: "Opus 4.8 1M", effortLevels: EFFORT_LEVELS.xhigh },
  { id: "claude-opus-4-8", label: "Opus 4.8", default: true, effortLevels: EFFORT_LEVELS.xhigh },
  { id: "claude-sonnet-5", label: "Sonnet 5", effortLevels: EFFORT_LEVELS.xhigh },
  { id: "claude-opus-4-7[1m]", label: "Opus 4.7 1M", effortLevels: EFFORT_LEVELS.xhigh },
  { id: "claude-opus-4-7", label: "Opus 4.7", effortLevels: EFFORT_LEVELS.xhigh },
  { id: "claude-opus-4-6[1m]", label: "Opus 4.6 1M", effortLevels: EFFORT_LEVELS.standard },
  { id: "claude-opus-4-6", label: "Opus 4.6", effortLevels: EFFORT_LEVELS.standard },
  { id: "claude-sonnet-4-6[1m]", label: "Sonnet 4.6 1M", effortLevels: EFFORT_LEVELS.standard },
  { id: "claude-sonnet-4-6", label: "Sonnet 4.6", effortLevels: EFFORT_LEVELS.standard },
  { id: "claude-haiku-4-5", label: "Haiku 4.5" },
] as const satisfies readonly ClaudeModelManifestEntry[];

/** 返回独立的模型 DTO，避免调用方意外修改静态 manifest。 */
export function claudeModelCatalog(): ClaudeModelOption[] {
  return CLAUDE_MODEL_MANIFEST.map((model) => {
    const supportedLevels = "effortLevels" in model ? [...model.effortLevels] : [];
    return {
      id: model.id,
      label: model.label,
      provider: "anthropic",
      ...("default" in model && model.default ? { default: true } : {}),
      thinking: {
        supportedLevels,
        defaultLevel: supportedLevels.includes("high") ? "high" : null,
      },
    };
  });
}

export function isClaudeThinkingLevel(value: string | null | undefined): boolean {
  return !value || (CLAUDE_THINKING_LEVELS as readonly string[]).includes(value);
}
