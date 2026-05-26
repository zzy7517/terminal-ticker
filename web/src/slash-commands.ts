/**
 * slash-commands.ts — Client-side slash command registry.
 *
 * - `/` triggers the command picker with all registered commands
 * - Some commands have argument completions (e.g., `/mention BTC` → instrument picker)
 * - The provider is the single source of truth for all autocomplete
 *
 * Adding a new command:
 * 1. Add to SLASH_COMMANDS below
 * 2. Optionally add `getArgumentCompletions` for sub-completions
 * 3. Handle dispatch in AgentSessionPanel's `dispatchSlashCommand`
 */

// ============================================================================
// Types
// ============================================================================

export interface AutocompleteItem {
  /** Value to insert (the full command text after /) */
  value: string;
  /** Display label */
  label: string;
  /** Optional description */
  description?: string;
}

export interface SlashCommand {
  /** Command name without leading slash */
  name: string;
  /** Short description shown in autocomplete */
  description: string;
  /** Aliases (e.g. /clone → /fork) */
  aliases?: string[];
  /** Hint for the argument (shown after command name) */
  argumentHint?: string;
  /** Get argument completions for this command */
  getArgumentCompletions?: (prefix: string, context: CommandContext) => AutocompleteItem[] | null;
}

export interface CommandContext {
  /** Available instruments from the watchlist */
  instruments: { key: string; label: string; symbol: string }[];
}

// ============================================================================
// Command Definitions
// ============================================================================

export const SLASH_COMMANDS: SlashCommand[] = [
  {
    name: 'mention',
    description: 'Insert instrument mention',
    aliases: ['@'],
    argumentHint: '<instrument>',
    getArgumentCompletions: (prefix: string, ctx: CommandContext): AutocompleteItem[] | null => {
      const query = prefix.trim().toLowerCase();
      const filtered = ctx.instruments.filter((inst) => {
        if (!query) return true;
        return (
          inst.key.toLowerCase().includes(query) ||
          inst.label.toLowerCase().includes(query) ||
          inst.symbol.toLowerCase().includes(query)
        );
      });
      if (filtered.length === 0) return null;
      return filtered.slice(0, 20).map((inst) => ({
        value: inst.key,
        label: inst.label,
        description: `${inst.symbol} · ${inst.key}`,
      }));
    },
  },
  { name: 'fork', description: 'Create a new session from a previous user message' },
  { name: 'clone', description: 'Duplicate current active branch into a new session' },
  { name: 'new', description: 'Start a new session' },
  { name: 'compact', description: 'Compact session context (coming soon)' },
];

// ============================================================================
// Autocomplete Engine
// ============================================================================

export interface AutocompleteSuggestion {
  items: AutocompleteItem[];
  /** What we're matching against (e.g., "/", "/fo", or argument prefix) */
  prefix: string;
  /** If suggestions are for command arguments, this is the parent command */
  command?: SlashCommand;
  /** Completion mode determines how selection is applied */
  mode: 'command' | 'argument';
}

/**
 * Core autocomplete logic.
 *
 * Given the full text before cursor, returns suggestions or null.
 */
export function getAutocompleteSuggestions(
  textBeforeCursor: string,
  context: CommandContext,
): AutocompleteSuggestion | null {
  // Must start with /
  if (!textBeforeCursor.startsWith('/')) return null;

  const spaceIndex = textBeforeCursor.indexOf(' ');

  // === No space yet: completing the command name ===
  if (spaceIndex === -1) {
    const prefix = textBeforeCursor.slice(1).toLowerCase();
    const items: AutocompleteItem[] = [];

    for (const cmd of SLASH_COMMANDS) {
      const nameMatch = cmd.name.toLowerCase().includes(prefix);
      const aliasMatch = cmd.aliases?.some((a) => a.toLowerCase().includes(prefix));
      if (nameMatch || aliasMatch) {
        const hint = cmd.argumentHint ? ` ${cmd.argumentHint}` : '';
        items.push({
          value: cmd.name,
          label: `/${cmd.name}${hint}`,
          description: cmd.description,
        });
      }
    }

    if (items.length === 0) return null;

    return {
      items,
      prefix: textBeforeCursor,
      mode: 'command',
    };
  }

  // === Space found: completing arguments for a specific command ===
  const commandName = textBeforeCursor.slice(1, spaceIndex).toLowerCase();
  const argumentText = textBeforeCursor.slice(spaceIndex + 1);

  const command = SLASH_COMMANDS.find(
    (cmd) => cmd.name === commandName || cmd.aliases?.includes(commandName),
  );

  if (!command?.getArgumentCompletions) return null;

  const argumentItems = command.getArgumentCompletions(argumentText, context);
  if (!argumentItems || argumentItems.length === 0) return null;

  return {
    items: argumentItems,
    prefix: argumentText,
    command,
    mode: 'argument',
  };
}

/**
 * Apply a completion selection to the current input text.
 * Returns the new full text for the input.
 */
export function applyCompletion(
  suggestion: AutocompleteSuggestion,
  selectedItem: AutocompleteItem,
): string {
  if (suggestion.mode === 'command') {
    // Replace with "/<command> " (or just "/<command>" for commands with no args)
    const cmd = SLASH_COMMANDS.find((c) => c.name === selectedItem.value);
    if (cmd?.getArgumentCompletions) {
      return `/${selectedItem.value} `;
    }
    return `/${selectedItem.value}`;
  }

  // Argument mode: produce the fully resolved text
  // For /mention, we want to produce "@KEY " directly for insertion
  if (suggestion.command?.name === 'mention') {
    return `@${selectedItem.value} `;
  }

  return `/${suggestion.command?.name ?? ''} ${selectedItem.value}`;
}

/**
 * Parse a submitted input to see if it's a slash command.
 * Returns command + args, or null if it's normal prompt text.
 */
export function parseSlashCommand(
  input: string,
): { command: SlashCommand; args: string } | null {
  const trimmed = input.trim();
  if (!trimmed.startsWith('/')) return null;

  const parts = trimmed.slice(1).split(/\s+(.*)/);
  const name = parts[0]?.toLowerCase();
  const args = parts[1]?.trim() ?? '';

  if (!name) return null;

  const command = SLASH_COMMANDS.find(
    (cmd) => cmd.name === name || cmd.aliases?.includes(name),
  );

  return command ? { command, args } : null;
}
