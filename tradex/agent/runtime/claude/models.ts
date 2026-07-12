export interface ClaudeModelThinking {
  supportedLevels: string[];
  defaultLevel: string;
}

export interface ClaudeModelOption {
  id: string;
  label: string;
  provider: "anthropic";
  default?: boolean;
  thinking: ClaudeModelThinking;
}

export const CLAUDE_THINKING_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;

const DEFAULT_THINKING: ClaudeModelThinking = {
  supportedLevels: [...CLAUDE_THINKING_LEVELS],
  defaultLevel: "high",
};

/** Claude Code 没有账号级 model list 命令，因此维护一份短小的已知目录，同时允许 Agent 保存自定义完整 ID。 */
export function claudeModelCatalog(): ClaudeModelOption[] {
  return [
    { id: "sonnet", label: "Sonnet (latest)", provider: "anthropic", default: true, thinking: DEFAULT_THINKING },
    { id: "opus", label: "Opus (latest)", provider: "anthropic", thinking: DEFAULT_THINKING },
    { id: "haiku", label: "Haiku (latest)", provider: "anthropic", thinking: DEFAULT_THINKING },
    { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6", provider: "anthropic", thinking: DEFAULT_THINKING },
    { id: "claude-opus-4-6", label: "Claude Opus 4.6", provider: "anthropic", thinking: DEFAULT_THINKING },
  ];
}

export function isClaudeThinkingLevel(value: string | null | undefined): boolean {
  return !value || (CLAUDE_THINKING_LEVELS as readonly string[]).includes(value);
}
