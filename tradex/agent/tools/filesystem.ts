/**
 * Filesystem tools adapted from pi-mono's coding-agent tool pack.
 *
 * Provides: read_file, write_file, edit_file, list_directory, find_files, grep_search, run_command
 *
 * All paths are sandboxed to a configurable root directory (defaults to cwd).
 */

import { access, readFile, writeFile, mkdir, readdir, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { spawn } from "node:child_process";
import { resolve, relative, isAbsolute, dirname, join, sep } from "node:path";
import { ToolDefinition, ToolRegistry } from "./registry.js";

const MAX_LINES = 2000;
const MAX_BYTES = 50 * 1024;
const DEFAULT_LS_LIMIT = 500;
const DEFAULT_FIND_LIMIT = 1000;
const DEFAULT_GREP_LIMIT = 100;
const GREP_MAX_LINE_LENGTH = 500;

let SANDBOX_ROOT = process.cwd();

export function setFilesystemRoot(root: string): void {
  SANDBOX_ROOT = resolve(root);
}

export function getFilesystemRoot(): string {
  return SANDBOX_ROOT;
}

function resolveSandboxed(p: string): string {
  const resolved = isAbsolute(p) ? resolve(p) : resolve(SANDBOX_ROOT, p);
  if (resolved !== SANDBOX_ROOT && !resolved.startsWith(SANDBOX_ROOT + sep)) {
    throw new Error(`Access denied: path "${p}" is outside the allowed directory`);
  }
  return resolved;
}

function toPosix(p: string): string {
  return p.split(sep).join("/");
}

function truncateHead(content: string): { text: string; truncated: boolean; totalLines: number; outputLines: number } {
  const lines = content.split("\n");
  const totalLines = lines.length;
  const totalBytes = Buffer.byteLength(content, "utf-8");
  if (totalLines <= MAX_LINES && totalBytes <= MAX_BYTES) {
    return { text: content, truncated: false, totalLines, outputLines: totalLines };
  }
  const out: string[] = [];
  let bytes = 0;
  for (let i = 0; i < lines.length && i < MAX_LINES; i++) {
    const lb = Buffer.byteLength(lines[i], "utf-8") + (i > 0 ? 1 : 0);
    if (bytes + lb > MAX_BYTES) break;
    out.push(lines[i]);
    bytes += lb;
  }
  return { text: out.join("\n"), truncated: true, totalLines, outputLines: out.length };
}

function truncateTail(content: string): { text: string; truncated: boolean; totalLines: number; outputLines: number } {
  const lines = content.split("\n");
  const totalLines = lines.length;
  const totalBytes = Buffer.byteLength(content, "utf-8");
  if (totalLines <= MAX_LINES && totalBytes <= MAX_BYTES) {
    return { text: content, truncated: false, totalLines, outputLines: totalLines };
  }
  const out: string[] = [];
  let bytes = 0;
  for (let i = lines.length - 1; i >= 0 && out.length < MAX_LINES; i--) {
    const lb = Buffer.byteLength(lines[i], "utf-8") + (out.length > 0 ? 1 : 0);
    if (bytes + lb > MAX_BYTES) break;
    out.unshift(lines[i]);
    bytes += lb;
  }
  return { text: out.join("\n"), truncated: true, totalLines, outputLines: out.length };
}

function runShell(command: string, cwd: string, timeout?: number): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((res, rej) => {
    const child = spawn("/bin/bash", ["-c", command], { cwd, stdio: ["ignore", "pipe", "pipe"], env: process.env });
    let stdout = "", stderr = "";
    let killed = false;
    const timer = timeout ? setTimeout(() => { killed = true; child.kill("SIGKILL"); }, timeout * 1000) : undefined;
    child.stdout.on("data", (c: Buffer) => { stdout += c.toString(); });
    child.stderr.on("data", (c: Buffer) => { stderr += c.toString(); });
    child.on("error", (e) => { if (timer) clearTimeout(timer); rej(e); });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      if (killed) { rej(new Error(`Command timed out after ${timeout}s`)); return; }
      res({ stdout, stderr, code });
    });
  });
}

// ============================================================================
// TOOL DEFINITIONS
// ============================================================================

const readFileTool: ToolDefinition = {
  name: "read_file",
  description: "Read the contents of a file. Output truncated to 2000 lines or 50KB. Use offset/limit for large files.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Path to the file to read (relative or absolute)" },
      offset: { type: "number", description: "Line number to start reading from (1-indexed)" },
      limit: { type: "number", description: "Maximum number of lines to read" },
    },
    required: ["path"],
  },
  handler: async (args) => {
    const filePath = resolveSandboxed(args.path as string);
    const offset = args.offset as number | undefined;
    const limit = args.limit as number | undefined;

    await access(filePath, constants.R_OK);
    const content = await readFile(filePath, "utf-8");
    const allLines = content.split("\n");
    const totalLines = allLines.length;
    const startLine = offset ? Math.max(0, offset - 1) : 0;

    if (startLine >= allLines.length) {
      throw new Error(`Offset ${offset} is beyond end of file (${totalLines} lines)`);
    }

    let selected: string;
    let userLimited = false;
    if (limit !== undefined) {
      const end = Math.min(startLine + limit, allLines.length);
      selected = allLines.slice(startLine, end).join("\n");
      userLimited = end < allLines.length;
    } else {
      selected = allLines.slice(startLine).join("\n");
    }

    const r = truncateHead(selected);
    if (r.truncated) {
      const endLine = (startLine + 1) + r.outputLines - 1;
      return `${r.text}\n\n[Showing lines ${startLine + 1}-${endLine} of ${totalLines}. Use offset=${endLine + 1} to continue.]`;
    }
    if (userLimited) {
      const nextOffset = startLine + (limit ?? 0) + 1;
      const remaining = allLines.length - (startLine + (limit ?? 0));
      return `${r.text}\n\n[${remaining} more lines. Use offset=${nextOffset} to continue.]`;
    }
    return r.text;
  },
};

const writeFileTool: ToolDefinition = {
  name: "write_file",
  description: "Write content to a file. Creates it if missing, overwrites if exists. Auto-creates parent directories.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Path to the file to write" },
      content: { type: "string", description: "Content to write" },
    },
    required: ["path", "content"],
  },
  handler: async (args) => {
    const filePath = resolveSandboxed(args.path as string);
    const content = args.content as string;
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, content, "utf-8");
    return `Wrote ${Buffer.byteLength(content, "utf-8")} bytes to ${args.path}`;
  },
};

const editFileTool: ToolDefinition = {
  name: "edit_file",
  description: "Edit a file via exact text replacement. Each oldText must be unique. Edits matched against original content.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Path to the file to edit" },
      edits: {
        type: "array",
        description: "Replacements: [{oldText, newText}, ...]",
        items: {
          type: "object",
          properties: {
            oldText: { type: "string", description: "Exact text to find (must be unique)" },
            newText: { type: "string", description: "Replacement text" },
          },
          required: ["oldText", "newText"],
        },
      },
    },
    required: ["path", "edits"],
  },
  handler: async (args) => {
    const filePath = resolveSandboxed(args.path as string);
    const edits = args.edits as Array<{ oldText: string; newText: string }>;
    if (!edits || edits.length === 0) throw new Error("edits must not be empty");

    await access(filePath, constants.R_OK | constants.W_OK);
    let content = await readFile(filePath, "utf-8");

    for (const edit of edits) {
      const count = content.split(edit.oldText).length - 1;
      if (count === 0) throw new Error(`oldText not found in file:\n${edit.oldText.slice(0, 200)}`);
      if (count > 1) throw new Error(`oldText matches ${count} locations (must be unique):\n${edit.oldText.slice(0, 200)}`);
    }
    for (const edit of edits) {
      content = content.replace(edit.oldText, edit.newText);
    }
    await writeFile(filePath, content, "utf-8");
    return `Applied ${edits.length} edit(s) to ${args.path}`;
  },
};

const listDirectoryTool: ToolDefinition = {
  name: "list_directory",
  description: "List directory contents sorted alphabetically. Dirs suffixed with '/'. Max 500 entries.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Directory to list (default: .)" },
      limit: { type: "number", description: "Max entries (default: 500)" },
    },
    required: [],
  },
  handler: async (args) => {
    const dirPath = resolveSandboxed((args.path as string) || ".");
    const limit = (args.limit as number) ?? DEFAULT_LS_LIMIT;
    const st = await stat(dirPath);
    if (!st.isDirectory()) throw new Error(`Not a directory: ${args.path || "."}`);

    const entries = await readdir(dirPath);
    entries.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));

    const results: string[] = [];
    for (const entry of entries) {
      if (results.length >= limit) break;
      try {
        const s = await stat(join(dirPath, entry));
        results.push(entry + (s.isDirectory() ? "/" : ""));
      } catch { continue; }
    }

    if (results.length === 0) return "(empty directory)";
    let output = results.join("\n");
    if (entries.length > limit) output += `\n\n[${entries.length - limit} more entries not shown]`;
    return output;
  },
};

const findFilesTool: ToolDefinition = {
  name: "find_files",
  description: "Find files by name pattern. Paths relative to search dir. Max 1000 results. Excludes node_modules/.git.",
  parameters: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Name pattern, e.g. '*.ts'" },
      path: { type: "string", description: "Search directory (default: .)" },
      limit: { type: "number", description: "Max results (default: 1000)" },
    },
    required: ["pattern"],
  },
  handler: async (args) => {
    const searchPath = resolveSandboxed((args.path as string) || ".");
    const pattern = args.pattern as string;
    const limit = (args.limit as number) ?? DEFAULT_FIND_LIMIT;

    const nameFlag = pattern.includes("/") ? "-path" : "-name";
    const pat = pattern.includes("/") ? `*${pattern}` : pattern;
    const findArgs = [searchPath, nameFlag, pat, "-not", "-path", "*/node_modules/*", "-not", "-path", "*/.git/*"];

    const stdout = await new Promise<string>((res, rej) => {
      const child = spawn("find", findArgs, { cwd: SANDBOX_ROOT, stdio: ["ignore", "pipe", "pipe"] });
      let out = "";
      child.stdout.on("data", (c: Buffer) => { out += c.toString(); });
      child.on("error", rej);
      child.on("close", () => res(out));
    });

    if (!stdout.trim()) return "No files found matching pattern";

    const lines = stdout.trim().split("\n").filter(Boolean);
    const hitLimit = lines.length > limit;
    const relativized = lines.slice(0, limit).map((p) => toPosix(relative(searchPath, p)));
    let output = relativized.join("\n");
    if (hitLimit) output += `\n\n[Results limited to ${limit}. Refine pattern for more.]`;
    return truncateHead(output).text;
  },
};

const grepSearchTool: ToolDefinition = {
  name: "grep_search",
  description: "Search file contents for a pattern. Returns file:line: match. Max 100 matches. Long lines truncated to 500 chars.",
  parameters: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Search pattern (regex)" },
      path: { type: "string", description: "Dir or file to search (default: .)" },
      include: { type: "string", description: "Glob filter, e.g. '*.ts'" },
      ignore_case: { type: "boolean", description: "Case-insensitive (default: false)" },
      literal: { type: "boolean", description: "Literal string match (default: false)" },
      limit: { type: "number", description: "Max matches (default: 100)" },
    },
    required: ["pattern"],
  },
  handler: async (args) => {
    const searchPath = resolveSandboxed((args.path as string) || ".");
    const pattern = args.pattern as string;
    const include = args.include as string | undefined;
    const ignoreCase = args.ignore_case as boolean | undefined;
    const literal = args.literal as boolean | undefined;
    const limit = (args.limit as number) ?? DEFAULT_GREP_LIMIT;

    const grepArgs = ["-rn", "--color=never"];
    if (ignoreCase) grepArgs.push("-i");
    if (literal) grepArgs.push("-F");
    if (include) grepArgs.push(`--include=${include}`);
    grepArgs.push("--exclude-dir=node_modules", "--exclude-dir=.git");
    grepArgs.push("--", pattern, searchPath);

    const stdout = await new Promise<string>((res, rej) => {
      const child = spawn("grep", grepArgs, { cwd: SANDBOX_ROOT, stdio: ["ignore", "pipe", "pipe"] });
      let out = "";
      let count = 0;
      child.stdout.on("data", (c: Buffer) => {
        out += c.toString();
        count = out.split("\n").length;
        if (count > limit + 10) child.kill();
      });
      child.on("error", rej);
      child.on("close", () => res(out));
    });

    if (!stdout.trim()) return "No matches found";

    const lines = stdout.trim().split("\n").filter(Boolean);
    const hitLimit = lines.length > limit;
    const outputLines = lines.slice(0, limit).map((line) => {
      // Make paths relative
      if (line.startsWith(searchPath)) {
        line = line.slice(searchPath.length + 1);
      }
      // Truncate long lines
      const colonIdx = line.indexOf(":", line.indexOf(":") + 1);
      if (colonIdx > 0 && line.length > colonIdx + GREP_MAX_LINE_LENGTH) {
        line = line.slice(0, colonIdx + GREP_MAX_LINE_LENGTH) + "... [truncated]";
      }
      return line;
    });

    let output = outputLines.join("\n");
    if (hitLimit) output += `\n\n[${limit} matches limit reached. Refine pattern for more specific results.]`;
    return truncateHead(output).text;
  },
};

const runCommandTool: ToolDefinition = {
  name: "run_command",
  description: "Execute a bash command in the sandbox directory. Returns stdout+stderr. Output truncated to last 2000 lines or 50KB. Optionally set a timeout.",
  parameters: {
    type: "object",
    properties: {
      command: { type: "string", description: "Bash command to execute" },
      timeout: { type: "number", description: "Timeout in seconds (optional)" },
    },
    required: ["command"],
  },
  handler: async (args) => {
    const command = args.command as string;
    const timeout = args.timeout as number | undefined;

    const { stdout, stderr, code } = await runShell(command, SANDBOX_ROOT, timeout);
    const combined = (stdout + stderr).trim();

    if (!combined) {
      if (code !== 0) return `(no output)\n\nCommand exited with code ${code}`;
      return "(no output)";
    }

    const r = truncateTail(combined);
    let output = r.text;
    if (r.truncated) {
      output += `\n\n[Output truncated. Showing last ${r.outputLines} of ${r.totalLines} lines.]`;
    }
    if (code !== 0) {
      output += `\n\nCommand exited with code ${code}`;
    }
    return output;
  },
};

// ============================================================================
// REGISTRY FACTORY
// ============================================================================

/** All filesystem tool definitions */
export const filesystemTools: ToolDefinition[] = [
  readFileTool,
  writeFileTool,
  editFileTool,
  listDirectoryTool,
  findFilesTool,
  grepSearchTool,
  runCommandTool,
];

/** Create a ToolRegistry with all filesystem tools pre-registered. */
export function createFilesystemRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  for (const tool of filesystemTools) {
    registry.register(tool);
  }
  return registry;
}

/** Register all filesystem tools into an existing registry. */
export function registerFilesystemTools(registry: ToolRegistry): void {
  for (const tool of filesystemTools) {
    registry.register(tool);
  }
}
