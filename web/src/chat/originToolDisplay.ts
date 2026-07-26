/**
 * Normalizes tool calls from the three Origin runtimes into one compact display shape.
 *
 * Pi SDK, Claude Code and Cursor CLI each name their tools differently and each
 * serialises results in their own way — Cursor in particular hands us the whole
 * result object as one line of JSON. This module turns any of them into a single
 * headline (icon, name, one-line summary) plus the raw material for a detail view,
 * so the timeline never has to render a payload verbatim.
 */

export type OriginToolIcon =
  | 'shell'
  | 'read'
  | 'edit'
  | 'search'
  | 'list'
  | 'fetch'
  | 'task'
  | 'tool';

/** `pending` is a call whose result never made it into the transcript. */
export type OriginToolStatus = 'running' | 'pending' | 'ok' | 'error';

export interface OriginToolView {
  /** Display name, e.g. `Shell`, `Grep`, `Get Quote`. */
  label: string;
  icon: OriginToolIcon;
  /** One line: the command, the path, the pattern. Empty when nothing stands out. */
  summary: string;
  /** Secondary hint shown at the end of the row, e.g. `exit 1`, `0 matches`. */
  detail: string;
  status: OriginToolStatus;
  /** Pretty-printed arguments; empty when the call had none. */
  input: string;
  /** Cleaned result body; empty when the call produced nothing readable. */
  output: string;
  truncated: boolean;
}

export interface OriginToolViewInput {
  name: string;
  arguments?: Record<string, unknown> | null;
  output?: string | null;
  isError?: boolean;
  running?: boolean;
  /** Session workspace, stripped from paths so the timeline shows relative ones. */
  workspace?: string | null;
}

type ToolKind =
  | 'shell'
  | 'read'
  | 'write'
  | 'edit'
  | 'search'
  | 'list'
  | 'fetch'
  | 'task'
  | 'todo'
  | 'other';

/** Cursor names arrive already stripped of their `ToolCall` suffix by the runtime adapter. */
const KNOWN_TOOLS: Record<string, { kind: ToolKind; label: string }> = {
  // Claude Code
  bash: { kind: 'shell', label: 'Shell' },
  read: { kind: 'read', label: 'Read' },
  write: { kind: 'write', label: 'Write' },
  edit: { kind: 'edit', label: 'Edit' },
  multiedit: { kind: 'edit', label: 'Edit' },
  notebookedit: { kind: 'edit', label: 'Edit' },
  glob: { kind: 'search', label: 'Glob' },
  grep: { kind: 'search', label: 'Grep' },
  webfetch: { kind: 'fetch', label: 'Fetch' },
  websearch: { kind: 'fetch', label: 'Search' },
  task: { kind: 'task', label: 'Task' },
  todowrite: { kind: 'todo', label: 'Todo' },
  ls: { kind: 'list', label: 'List' },
  // Cursor CLI
  shell: { kind: 'shell', label: 'Shell' },
  terminal: { kind: 'shell', label: 'Shell' },
  delete: { kind: 'edit', label: 'Delete' },
  search: { kind: 'search', label: 'Search' },
  // Pi SDK
  run_command: { kind: 'shell', label: 'Shell' },
  read_file: { kind: 'read', label: 'Read' },
  write_file: { kind: 'write', label: 'Write' },
  edit_file: { kind: 'edit', label: 'Edit' },
  find_files: { kind: 'search', label: 'Glob' },
  grep_search: { kind: 'search', label: 'Grep' },
  codebase_search: { kind: 'search', label: 'Search' },
  list_directory: { kind: 'list', label: 'List' },
  web_fetch: { kind: 'fetch', label: 'Fetch' },
  web_search: { kind: 'fetch', label: 'Search' },
};

const ICON_BY_KIND: Record<ToolKind, OriginToolIcon> = {
  shell: 'shell',
  read: 'read',
  write: 'edit',
  edit: 'edit',
  search: 'search',
  list: 'list',
  fetch: 'fetch',
  task: 'task',
  todo: 'tool',
  other: 'tool',
};

/** Argument keys worth putting in the headline, most specific first. */
const SUMMARY_KEYS: Record<ToolKind, string[]> = {
  shell: ['command', 'cmd', 'script'],
  read: ['file_path', 'filePath', 'path', 'target_file', 'absolute_path'],
  write: ['file_path', 'filePath', 'path', 'target_file', 'absolute_path'],
  edit: ['file_path', 'filePath', 'path', 'target_file', 'absolute_path'],
  search: ['pattern', 'query', 'glob', 'regex', 'search_term'],
  list: ['path', 'dir', 'directory', 'target_directory'],
  fetch: ['url', 'query', 'prompt'],
  task: ['description', 'prompt', 'subagent_type'],
  todo: [],
  other: [],
};

const PATH_KINDS = new Set<ToolKind>(['read', 'write', 'edit', 'list']);
const MAX_OUTPUT = 4_000;
const MAX_SUMMARY = 220;

export function buildOriginToolView(input: OriginToolViewInput): OriginToolView {
  const known = KNOWN_TOOLS[input.name.trim().toLowerCase()];
  const kind = known?.kind ?? 'other';
  const args = isRecord(input.arguments) ? input.arguments : {};
  const result = parseToolOutput(input.output ?? '', input.workspace ?? null);

  const rawSummary = pickSummary(args, kind) ?? pickSummary(result.hints, kind) ?? '';
  const summary = clip(
    PATH_KINDS.has(kind) ? shortenPath(rawSummary, input.workspace ?? null) : collapse(rawSummary),
    MAX_SUMMARY,
  );

  const output = result.body.length > MAX_OUTPUT ? result.body.slice(0, MAX_OUTPUT) : result.body;
  return {
    label: known?.label ?? humanizeToolName(input.name),
    icon: ICON_BY_KIND[kind],
    summary,
    detail: result.detail,
    status: toolStatus(input, result.error),
    input: Object.keys(args).length > 0 ? JSON.stringify(args, null, 2) : '',
    output,
    truncated: result.body.length > MAX_OUTPUT,
  };
}

function toolStatus(input: OriginToolViewInput, payloadFailed: boolean): OriginToolStatus {
  if (input.running) return 'running';
  if (input.isError || payloadFailed) return 'error';
  // An absent `output` means no result was recorded; an empty one means it was silent.
  return input.output === undefined || input.output === null ? 'pending' : 'ok';
}

/** Paseo's rule: leave qualified names (MCP, namespaced) alone, title-case the rest. */
export function humanizeToolName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return 'Tool';
  if (/[:./]/.test(trimmed) || trimmed.includes('__')) return trimmed;
  const spaced = /[._-]/.test(trimmed)
    ? trimmed.replace(/[._-]+/g, ' ')
    : trimmed.replace(/([a-z0-9])([A-Z])/g, '$1 $2');
  return spaced
    .split(' ')
    .filter(Boolean)
    .map((segment) => `${segment[0].toUpperCase()}${segment.slice(1)}`)
    .join(' ');
}

interface ParsedToolOutput {
  body: string;
  detail: string;
  error: boolean;
  /** Fields recovered from the payload, used when the call arguments are unavailable. */
  hints: Record<string, unknown>;
}

function parseToolOutput(raw: string, workspace: string | null): ParsedToolOutput {
  const trimmed = raw.trim();
  if (!trimmed) return { body: '', detail: '', error: false, hints: {} };

  const parsed = tryParseJson(trimmed);
  if (!isRecord(parsed)) {
    return { body: Array.isArray(parsed) ? pretty(parsed) : trimmed, detail: '', error: false, hints: {} };
  }

  const stats = { ...parsed, ...flattenWorkspaceResults(parsed) };
  const errorText = readString(stats.errorMessage) ?? readString(stats.error) ?? readString(stats.failure);
  return {
    body: errorText ?? resultBody(stats, workspace) ?? pretty(parsed),
    detail: resultDetail(stats),
    error: Boolean(errorText),
    hints: stats,
  };
}

/**
 * Cursor nests search results one level down, keyed by the searched directory:
 * `{ workspaceResults: { "/abs/path": { content: { matches, totalLines, … } } } }`.
 */
function flattenWorkspaceResults(value: Record<string, unknown>): Record<string, unknown> {
  const nested = value.workspaceResults;
  if (!isRecord(nested)) return {};
  const merged: Record<string, unknown> = {};
  for (const entry of Object.values(nested)) {
    if (!isRecord(entry)) continue;
    Object.assign(merged, entry, isRecord(entry.content) ? entry.content : {});
  }
  return merged;
}

/** The readable part of a result object, or null when it has no obvious body. */
function resultBody(stats: Record<string, unknown>, workspace: string | null): string | null {
  if (typeof stats.stdout === 'string' || typeof stats.stderr === 'string') {
    // `interleavedOutput` repeats stdout and stderr; keep the separated form.
    const stdout = readString(stats.stdout) ?? '';
    const stderr = readString(stats.stderr) ?? '';
    return [stdout, stderr].filter(Boolean).join('\n').trim();
  }
  if (Array.isArray(stats.files)) {
    return stats.files
      .map((file) => shortenPath(String(file), workspace))
      .join('\n');
  }
  if (Array.isArray(stats.matches)) {
    return stats.matches.every((match) => typeof match === 'string')
      ? stats.matches.join('\n')
      : stats.matches.length > 0 ? pretty(stats.matches) : '';
  }
  const direct = readString(stats.content)
    ?? readString(stats.text)
    ?? readString(stats.output)
    ?? readString(stats.result);
  return direct ?? null;
}

function resultDetail(stats: Record<string, unknown>): string {
  const chips: string[] = [];
  const exitCode = stats.exitCode;
  if (typeof exitCode === 'number' && exitCode !== 0) chips.push(`exit ${exitCode}`);
  const matches = countOf(stats.totalMatchedLines, stats.matches);
  if (matches !== null) chips.push(`${matches} ${matches === 1 ? 'match' : 'matches'}`);
  const files = countOf(stats.totalFiles, stats.files);
  if (files !== null) chips.push(`${files} ${files === 1 ? 'file' : 'files'}`);
  return chips.join(' · ');
}

function countOf(total: unknown, list: unknown): number | null {
  if (typeof total === 'number') return total;
  if (Array.isArray(list)) return list.length;
  return null;
}

function pickSummary(source: Record<string, unknown>, kind: ToolKind): string | undefined {
  for (const key of SUMMARY_KEYS[kind]) {
    const value = readString(source[key]);
    if (value) return value;
  }
  for (const key of ['command', 'pattern', 'query', 'file_path', 'path', 'url']) {
    const value = readString(source[key]);
    if (value) return value;
  }
  // Unknown tools still deserve a headline; the first short single line will do.
  // Anything longer is a body, not a label — file contents must not land up here.
  for (const value of Object.values(source)) {
    const text = readString(value);
    if (text && text.length <= 120 && !text.includes('\n')) return text;
  }
  return undefined;
}

/** Strips the Session workspace, then the home directory, from an absolute path. */
export function shortenPath(value: string, workspace: string | null): string {
  const trimmed = value.trim();
  if (!trimmed) return '';
  const root = workspace?.replace(/\/+$/, '') ?? '';
  if (root && trimmed === root) return '.';
  if (root && trimmed.startsWith(`${root}/`)) return trimmed.slice(root.length + 1);
  const home = homeDirectory(root) ?? homeDirectory(trimmed);
  if (home && trimmed.startsWith(`${home}/`)) return `~${trimmed.slice(home.length)}`;
  return trimmed;
}

function homeDirectory(value: string): string | null {
  return /^(\/(?:Users|home)\/[^/]+)(?:\/|$)/.exec(value)?.[1] ?? null;
}

function collapse(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function clip(value: string, limit: number): string {
  return value.length > limit ? `${value.slice(0, limit - 1)}…` : value;
}

function pretty(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function tryParseJson(value: string): unknown {
  if (!/^[[{]/.test(value)) return null;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
