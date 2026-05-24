/**
 * Filesystem tools aligned with pi-mono's coding-agent tool pack.
 *
 * Provides: read_file, write_file, edit_file, list_directory, find_files, grep_search, run_command
 *
 * Key alignment with pi:
 * - No sandbox restriction (paths resolve relative to configurable root)
 * - Pluggable operations interfaces for all tools
 * - AbortSignal support on all tools
 * - File mutation queue for write/edit serialization
 * - BOM/CRLF/fuzzy matching in edit
 * - OutputAccumulator for bash (temp file on overflow)
 * - fd/rg with fallback to find/grep
 * - .gitignore respect via fd/rg
 */

import { access, readFile, writeFile, mkdir, readdir, stat } from "node:fs/promises";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { constants } from "node:fs";
import { execSync, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { resolve, relative, dirname, join, sep } from "node:path";
import { ToolDefinition, ToolRegistry } from "./registry.js";
import { resolveToCwd, resolveReadPath } from "./path-utils.js";
import { withFileMutationQueue } from "./file-mutation-queue.js";
import {
  applyEditsToNormalizedContent,
  detectLineEnding,
  generateDiffString,
  generateUnifiedPatch,
  normalizeToLF,
  restoreLineEndings,
  stripBom,
  type Edit,
} from "./edit-diff.js";
import { OutputAccumulator } from "./output-accumulator.js";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  GREP_MAX_LINE_LENGTH,
  formatSize,
  truncateHead,
  truncateLine,
  truncateTail,
} from "./truncate.js";

// ============================================================================
// CONFIGURATION
// ============================================================================

let ROOT_CWD = process.cwd();

export function setFilesystemRoot(root: string): void {
  ROOT_CWD = resolve(root);
}

export function getFilesystemRoot(): string {
  return ROOT_CWD;
}

function toPosix(p: string): string {
  return p.split(sep).join("/");
}

// ============================================================================
// BASH: process tree kill + local operations
// ============================================================================

function killProcessTree(pid: number): void {
  try {
    if (process.platform !== "win32") {
      process.kill(-pid, "SIGKILL");
    } else {
      process.kill(pid, "SIGKILL");
    }
  } catch {
    try { process.kill(pid, "SIGKILL"); } catch { /* already dead */ }
  }
}

function createLocalBashOperations() {
  return {
    exec: (command: string, cwd: string, { onData, signal, timeout, env }: { onData: (data: Buffer) => void; signal?: AbortSignal; timeout?: number; env?: NodeJS.ProcessEnv }): Promise<{ exitCode: number | null }> => {
      return new Promise<{ exitCode: number | null }>((resolve, reject) => {
        if (!existsSync(cwd)) {
          reject(new Error(`Working directory does not exist: ${cwd}\nCannot execute bash commands.`));
          return;
        }
        const child = spawn("/bin/bash", ["-c", command], {
          cwd,
          detached: process.platform !== "win32",
          env: env ?? process.env,
          stdio: ["ignore", "pipe", "pipe"],
        });
        let timedOut = false;
        let timeoutHandle: NodeJS.Timeout | undefined;
        if (timeout !== undefined && timeout > 0) {
          timeoutHandle = setTimeout(() => {
            timedOut = true;
            if (child.pid) killProcessTree(child.pid);
          }, timeout * 1000);
        }
        child.stdout?.on("data", onData);
        child.stderr?.on("data", onData);
        const onAbort = () => { if (child.pid) killProcessTree(child.pid); };
        if (signal) {
          if (signal.aborted) onAbort();
          else signal.addEventListener("abort", onAbort, { once: true });
        }
        child.on("error", (err) => {
          if (timeoutHandle) clearTimeout(timeoutHandle);
          if (signal) signal.removeEventListener("abort", onAbort);
          reject(err);
        });
        child.on("close", (code) => {
          if (timeoutHandle) clearTimeout(timeoutHandle);
          if (signal) signal.removeEventListener("abort", onAbort);
          if (signal?.aborted) { reject(new Error("aborted")); return; }
          if (timedOut) { reject(new Error(`timeout:${timeout}`)); return; }
          resolve({ exitCode: code });
        });
      });
    },
  };
}

// ============================================================================
// UTILITY: which (find fd/rg on PATH)
// ============================================================================

function which(name: string): string | null {
  try {
    return execSync(`which ${name}`, { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }).trim() || null;
  } catch {
    return null;
  }
}

let _fdPath: string | null | undefined;
function getFdPath(): string | null {
  if (_fdPath === undefined) _fdPath = which("fd");
  return _fdPath;
}

let _rgPath: string | null | undefined;
function getRgPath(): string | null {
  if (_rgPath === undefined) _rgPath = which("rg");
  return _rgPath;
}

// ============================================================================
// CONSTANTS
// ============================================================================

const DEFAULT_LS_LIMIT = 500;
const DEFAULT_FIND_LIMIT = 1000;
const DEFAULT_GREP_LIMIT = 100;

// ============================================================================
// TOOL: read_file
// ============================================================================

const readFileTool: ToolDefinition = {
  name: "read_file",
  description: `Read the contents of a file. Supports text files and images (jpg, png, gif, webp). Images are sent as attachments. For text files, output is truncated to ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first). Use offset/limit for large files. When you need the full file, continue with offset until complete.`,
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Path to the file to read (relative or absolute)" },
      offset: { type: "number", description: "Line number to start reading from (1-indexed)" },
      limit: { type: "number", description: "Maximum number of lines to read" },
    },
    required: ["path"],
  },
  execute: async (args, signal?) => {
    const filePath = args.path as string;
    const offset = args.offset as number | undefined;
    const limit = args.limit as number | undefined;
    const absolutePath = resolveReadPath(filePath, ROOT_CWD);

    if (signal?.aborted) throw new Error("Operation aborted");
    await access(absolutePath, constants.R_OK);
    if (signal?.aborted) throw new Error("Operation aborted");

    const ext = absolutePath.toLowerCase().split(".").pop() ?? "";
    const imageExts: Record<string, string> = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif", webp: "image/webp" };
    const mimeType = imageExts[ext] ?? null;
    if (mimeType) {
      const buffer = await readFile(absolutePath);
      const base64 = buffer.toString("base64");
      return {
        content: [
          { type: "text" as const, text: `Read image file [${mimeType}]` },
          { type: "image" as const, data: base64, mimeType },
        ],
      };
    }

    const buffer = await readFile(absolutePath);
    if (signal?.aborted) throw new Error("Operation aborted");
    const textContent = buffer.toString("utf-8");
    const allLines = textContent.split("\n");
    const totalFileLines = allLines.length;
    const startLine = offset ? Math.max(0, offset - 1) : 0;
    const startLineDisplay = startLine + 1;

    if (startLine >= allLines.length) {
      throw new Error(`Offset ${offset} is beyond end of file (${allLines.length} lines total)`);
    }

    let selectedContent: string;
    let userLimitedLines: number | undefined;
    if (limit !== undefined) {
      const endLine = Math.min(startLine + limit, allLines.length);
      selectedContent = allLines.slice(startLine, endLine).join("\n");
      userLimitedLines = endLine - startLine;
    } else {
      selectedContent = allLines.slice(startLine).join("\n");
    }

    const truncation = truncateHead(selectedContent);
    let outputText: string;
    if (truncation.firstLineExceedsLimit) {
      const firstLineSize = formatSize(Buffer.byteLength(allLines[startLine], "utf-8"));
      outputText = `[Line ${startLineDisplay} is ${firstLineSize}, exceeds ${formatSize(DEFAULT_MAX_BYTES)} limit. Use bash: sed -n '${startLineDisplay}p' ${filePath} | head -c ${DEFAULT_MAX_BYTES}]`;
    } else if (truncation.truncated) {
      const endLineDisplay = startLineDisplay + truncation.outputLines - 1;
      const nextOffset = endLineDisplay + 1;
      outputText = truncation.content;
      if (truncation.truncatedBy === "lines") {
        outputText += `\n\n[Showing lines ${startLineDisplay}-${endLineDisplay} of ${totalFileLines}. Use offset=${nextOffset} to continue.]`;
      } else {
        outputText += `\n\n[Showing lines ${startLineDisplay}-${endLineDisplay} of ${totalFileLines} (${formatSize(DEFAULT_MAX_BYTES)} limit). Use offset=${nextOffset} to continue.]`;
      }
    } else if (userLimitedLines !== undefined && startLine + userLimitedLines < allLines.length) {
      const remaining = allLines.length - (startLine + userLimitedLines);
      const nextOffset = startLine + userLimitedLines + 1;
      outputText = `${truncation.content}\n\n[${remaining} more lines in file. Use offset=${nextOffset} to continue.]`;
    } else {
      outputText = truncation.content;
    }
    return outputText;
  },
};

// ============================================================================
// TOOL: write_file
// ============================================================================

const writeFileTool: ToolDefinition = {
  name: "write_file",
  description: "Write content to a file. Creates the file if it doesn't exist, overwrites if it does. Automatically creates parent directories.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Path to the file to write (relative or absolute)" },
      content: { type: "string", description: "Content to write to the file" },
    },
    required: ["path", "content"],
  },
  execute: async (args, signal?) => {
    const filePath = args.path as string;
    const content = args.content as string;
    const absolutePath = resolveToCwd(filePath, ROOT_CWD);
    const dir = dirname(absolutePath);

    return withFileMutationQueue(absolutePath, async () => {
      if (signal?.aborted) throw new Error("Operation aborted");
      await mkdir(dir, { recursive: true });
      if (signal?.aborted) throw new Error("Operation aborted");
      await writeFile(absolutePath, content, "utf-8");
      return `Successfully wrote ${content.length} bytes to ${filePath}`;
    });
  },
};

// ============================================================================
// TOOL: edit_file
// ============================================================================

function prepareEditArguments(input: Record<string, unknown>): { path: string; edits: Edit[] } {
  const args = { ...input };

  // Some models send edits as a JSON string instead of an array
  if (typeof args.edits === "string") {
    try {
      const parsed = JSON.parse(args.edits as string);
      if (Array.isArray(parsed)) args.edits = parsed;
    } catch { /* keep as-is */ }
  }

  // Legacy single oldText/newText compatibility
  if (typeof args.oldText === "string" && typeof args.newText === "string") {
    const edits = Array.isArray(args.edits) ? [...(args.edits as Edit[])] : [];
    edits.push({ oldText: args.oldText as string, newText: args.newText as string });
    return { path: args.path as string, edits };
  }

  return { path: args.path as string, edits: (args.edits as Edit[]) || [] };
}

export interface EditToolDetails {
  diff: string;
  patch: string;
  firstChangedLine?: number;
}

const editFileTool: ToolDefinition<EditToolDetails | undefined> = {
  name: "edit_file",
  description: "Edit a single file using exact text replacement. Every edits[].oldText must match a unique, non-overlapping region of the original file. If two changes affect the same block or nearby lines, merge them into one edit instead of emitting overlapping edits. Do not include large unchanged regions just to connect distant changes.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Path to the file to edit (relative or absolute)" },
      edits: {
        type: "array",
        description: "One or more targeted replacements. Each edit is matched against the original file, not incrementally. Do not include overlapping or nested edits. If two changes touch the same block or nearby lines, merge them into one edit instead.",
        items: {
          type: "object",
          properties: {
            oldText: { type: "string", description: "Exact text for one targeted replacement. It must be unique in the original file and must not overlap with any other edits[].oldText in the same call." },
            newText: { type: "string", description: "Replacement text for this targeted edit." },
          },
          required: ["oldText", "newText"],
        },
      },
      // Legacy compatibility
      oldText: { type: "string", description: "Legacy: single oldText (prefer edits[] array)" },
      newText: { type: "string", description: "Legacy: single newText (prefer edits[] array)" },
    },
    required: ["path"],
  },
  execute: async (args, signal?) => {
    const { path: filePath, edits } = prepareEditArguments(args);

    if (!edits || edits.length === 0) {
      throw new Error("Edit tool input is invalid. edits must contain at least one replacement.");
    }

    const absolutePath = resolveToCwd(filePath, ROOT_CWD);

    return withFileMutationQueue(absolutePath, async () => {
      if (signal?.aborted) throw new Error("Operation aborted");

      try {
        await access(absolutePath, constants.R_OK);
      } catch (error: unknown) {
        const errorMessage = error instanceof Error && "code" in error ? `Error code: ${(error as any).code}` : String(error);
        throw new Error(`Could not edit file: ${filePath}. ${errorMessage}.`);
      }

      if (signal?.aborted) throw new Error("Operation aborted");

      const buffer = await readFile(absolutePath);
      const rawContent = buffer.toString("utf-8");

      if (signal?.aborted) throw new Error("Operation aborted");

      // Strip BOM before matching
      const { bom, text: content } = stripBom(rawContent);
      const originalEnding = detectLineEnding(content);
      const normalizedContent = normalizeToLF(content);
      const { baseContent, newContent } = applyEditsToNormalizedContent(normalizedContent, edits, filePath);

      if (signal?.aborted) throw new Error("Operation aborted");

      const finalContent = bom + restoreLineEndings(newContent, originalEnding);
      await writeFile(absolutePath, finalContent, "utf-8");

      if (signal?.aborted) throw new Error("Operation aborted");

      const diffResult = generateDiffString(baseContent, newContent);
      const patch = generateUnifiedPatch(filePath, baseContent, newContent);
      return {
        content: [{ type: "text" as const, text: `Successfully replaced ${edits.length} block(s) in ${filePath}.` }],
        details: { diff: diffResult.diff, patch, firstChangedLine: diffResult.firstChangedLine },
      };
    });
  },
};

// ============================================================================
// TOOL: list_directory
// ============================================================================

const listDirectoryTool: ToolDefinition = {
  name: "list_directory",
  description: `List directory contents. Returns entries sorted alphabetically, with '/' suffix for directories. Includes dotfiles. Output is truncated to ${DEFAULT_LS_LIMIT} entries or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first).`,
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Directory to list (default: current directory)" },
      limit: { type: "number", description: "Maximum number of entries to return (default: 500)" },
    },
    required: [],
  },
  execute: async (args, signal?) => {
    const dirPath = resolveToCwd((args.path as string) || ".", ROOT_CWD);
    const effectiveLimit = (args.limit as number) ?? DEFAULT_LS_LIMIT;

    if (signal?.aborted) throw new Error("Operation aborted");

    if (!existsSync(dirPath)) {
      throw new Error(`Path not found: ${dirPath}`);
    }

    const s = await stat(dirPath);
    if (!s.isDirectory()) {
      throw new Error(`Not a directory: ${dirPath}`);
    }

    let entries: string[];
    try {
      entries = await readdir(dirPath);
    } catch (e: any) {
      throw new Error(`Cannot read directory: ${e.message}`);
    }

    entries.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));

    const results: string[] = [];
    let entryLimitReached = false;
    for (const entry of entries) {
      if (results.length >= effectiveLimit) {
        entryLimitReached = true;
        break;
      }
      if (signal?.aborted) throw new Error("Operation aborted");
      const fullPath = join(dirPath, entry);
      let suffix = "";
      try {
        const entryStat = await stat(fullPath);
        if (entryStat.isDirectory()) suffix = "/";
      } catch { continue; }
      results.push(entry + suffix);
    }

    if (results.length === 0) return "(empty directory)";

    const rawOutput = results.join("\n");
    const truncation = truncateHead(rawOutput, { maxLines: Number.MAX_SAFE_INTEGER });
    let output = truncation.content;
    const notices: string[] = [];
    if (entryLimitReached) {
      notices.push(`${effectiveLimit} entries limit reached. Use limit=${effectiveLimit * 2} for more`);
    }
    if (truncation.truncated) {
      notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
    }
    if (notices.length > 0) {
      output += `\n\n[${notices.join(". ")}]`;
    }
    return output;
  },
};

// ============================================================================
// TOOL: find_files (fd with fallback to find)
// ============================================================================

const findFilesTool: ToolDefinition = {
  name: "find_files",
  description: `Search for files by glob pattern. Returns matching file paths relative to the search directory. Respects .gitignore when fd is available. Output is truncated to ${DEFAULT_FIND_LIMIT} results or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first).`,
  parameters: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Glob pattern to match files, e.g. '*.ts', '**/*.json'" },
      path: { type: "string", description: "Directory to search in (default: current directory)" },
      limit: { type: "number", description: "Maximum number of results (default: 1000)" },
    },
    required: ["pattern"],
  },
  execute: async (args, signal?) => {
    const searchPath = resolveToCwd((args.path as string) || ".", ROOT_CWD);
    const pattern = args.pattern as string;
    const effectiveLimit = (args.limit as number) ?? DEFAULT_FIND_LIMIT;

    if (signal?.aborted) throw new Error("Operation aborted");

    const fdPath = getFdPath();

    if (fdPath) {
      // Use fd for better performance + .gitignore respect
      const fdArgs: string[] = [
        "--glob", "--color=never", "--hidden", "--no-require-git",
        "--max-results", String(effectiveLimit),
      ];

      let effectivePattern = pattern;
      if (pattern.includes("/")) {
        fdArgs.push("--full-path");
        if (!pattern.startsWith("/") && !pattern.startsWith("**/") && pattern !== "**") {
          effectivePattern = `**/${pattern}`;
        }
      }
      fdArgs.push("--", effectivePattern, searchPath);

      return new Promise<string>((resolvePromise, rejectPromise) => {
        const child = spawn(fdPath, fdArgs, { stdio: ["ignore", "pipe", "pipe"] });
        const rl = createInterface({ input: child.stdout });
        const lines: string[] = [];
        let stderr = "";

        const onAbort = () => { if (!child.killed) child.kill(); };
        if (signal) {
          if (signal.aborted) { onAbort(); rejectPromise(new Error("Operation aborted")); return; }
          signal.addEventListener("abort", onAbort, { once: true });
        }

        child.stderr?.on("data", (c: Buffer) => { stderr += c.toString(); });
        rl.on("line", (line) => { lines.push(line); });

        child.on("error", (err) => {
          signal?.removeEventListener("abort", onAbort);
          rejectPromise(new Error(`Failed to run fd: ${err.message}`));
        });

        child.on("close", (code) => {
          rl.close();
          signal?.removeEventListener("abort", onAbort);
          if (signal?.aborted) { rejectPromise(new Error("Operation aborted")); return; }

          if (!lines.length) {
            resolvePromise("No files found matching pattern");
            return;
          }

          const relativized = lines
            .map(l => l.replace(/\r$/, "").trim())
            .filter(Boolean)
            .map(l => {
              let rel = l.startsWith(searchPath) ? l.slice(searchPath.length + 1) : relative(searchPath, l);
              return toPosix(rel);
            });

          const resultLimitReached = relativized.length >= effectiveLimit;
          const rawOutput = relativized.join("\n");
          const truncation = truncateHead(rawOutput, { maxLines: Number.MAX_SAFE_INTEGER });
          let output = truncation.content;
          const notices: string[] = [];
          if (resultLimitReached) notices.push(`${effectiveLimit} results limit reached. Use limit=${effectiveLimit * 2} for more, or refine pattern`);
          if (truncation.truncated) notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
          if (notices.length > 0) output += `\n\n[${notices.join(". ")}]`;
          resolvePromise(output);
        });
      });
    }

    // Fallback to system find
    const nameFlag = pattern.includes("/") ? "-path" : "-name";
    const pat = pattern.includes("/") ? `*${pattern}` : pattern;
    const findArgs = [searchPath, nameFlag, pat, "-not", "-path", "*/node_modules/*", "-not", "-path", "*/.git/*"];

    return new Promise<string>((resolvePromise, rejectPromise) => {
      const child = spawn("find", findArgs, { cwd: ROOT_CWD, stdio: ["ignore", "pipe", "pipe"] });
      let out = "";

      const onAbort = () => { if (!child.killed) child.kill(); };
      if (signal) {
        if (signal.aborted) { onAbort(); rejectPromise(new Error("Operation aborted")); return; }
        signal.addEventListener("abort", onAbort, { once: true });
      }

      child.stdout.on("data", (c: Buffer) => { out += c.toString(); });
      child.on("error", (err) => {
        signal?.removeEventListener("abort", onAbort);
        rejectPromise(err);
      });
      child.on("close", () => {
        signal?.removeEventListener("abort", onAbort);
        if (signal?.aborted) { rejectPromise(new Error("Operation aborted")); return; }
        if (!out.trim()) { resolvePromise("No files found matching pattern"); return; }

        const lines = out.trim().split("\n").filter(Boolean);
        const hitLimit = lines.length > effectiveLimit;
        const relativized = lines.slice(0, effectiveLimit).map((p) => toPosix(relative(searchPath, p)));
        const rawOutput = relativized.join("\n");
        const truncation = truncateHead(rawOutput, { maxLines: Number.MAX_SAFE_INTEGER });
        let output = truncation.content;
        if (hitLimit) output += `\n\n[Results limited to ${effectiveLimit}. Refine pattern for more.]`;
        else if (truncation.truncated) output += `\n\n[${formatSize(DEFAULT_MAX_BYTES)} limit reached]`;
        resolvePromise(output);
      });
    });
  },
};

// ============================================================================
// TOOL: grep_search (rg with fallback to grep)
// ============================================================================

const grepSearchTool: ToolDefinition = {
  name: "grep_search",
  description: `Search file contents for a pattern. Returns matching lines with file paths and line numbers. Respects .gitignore when ripgrep is available. Output is truncated to ${DEFAULT_GREP_LIMIT} matches or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first). Long lines are truncated to ${GREP_MAX_LINE_LENGTH} chars.`,
  parameters: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Search pattern (regex or literal string)" },
      path: { type: "string", description: "Directory or file to search (default: current directory)" },
      include: { type: "string", description: "Filter files by glob pattern, e.g. '*.ts' or '**/*.spec.ts'" },
      ignore_case: { type: "boolean", description: "Case-insensitive search (default: false)" },
      literal: { type: "boolean", description: "Treat pattern as literal string instead of regex (default: false)" },
      context: { type: "number", description: "Number of lines to show before and after each match (default: 0)" },
      limit: { type: "number", description: "Maximum number of matches to return (default: 100)" },
    },
    required: ["pattern"],
  },
  execute: async (args, signal?) => {
    const searchPath = resolveToCwd((args.path as string) || ".", ROOT_CWD);
    const pattern = args.pattern as string;
    const include = args.include as string | undefined;
    const ignoreCase = args.ignore_case as boolean | undefined;
    const literal = args.literal as boolean | undefined;
    const contextLines = (args.context as number | undefined) ?? 0;
    const effectiveLimit = (args.limit as number) ?? DEFAULT_GREP_LIMIT;

    if (signal?.aborted) throw new Error("Operation aborted");

    const rgPath = getRgPath();

    if (rgPath) {
      // Use ripgrep for better performance + .gitignore respect
      return new Promise<string>((resolvePromise, rejectPromise) => {
        let isDir: boolean;
        try { isDir = statSync(searchPath).isDirectory(); } catch { rejectPromise(new Error(`Path not found: ${searchPath}`)); return; }

        const formatPath = (filePath: string): string => {
          if (isDir) {
            const rel = relative(searchPath, filePath);
            if (rel && !rel.startsWith("..")) return rel.replace(/\\/g, "/");
          }
          return require("node:path").basename(filePath);
        };

        const rgArgs: string[] = ["--json", "--line-number", "--color=never", "--hidden"];
        if (ignoreCase) rgArgs.push("--ignore-case");
        if (literal) rgArgs.push("--fixed-strings");
        if (include) rgArgs.push("--glob", include);
        rgArgs.push("--", pattern, searchPath);

        const child = spawn(rgPath, rgArgs, { stdio: ["ignore", "pipe", "pipe"] });
        const rl = createInterface({ input: child.stdout });
        let stderr = "";
        let matchCount = 0;
        let matchLimitReached = false;
        let linesTruncated = false;
        let killedDueToLimit = false;
        const matches: Array<{ filePath: string; lineNumber: number; lineText?: string }> = [];

        const onAbort = () => { if (!child.killed) child.kill(); };
        if (signal) {
          if (signal.aborted) { onAbort(); rejectPromise(new Error("Operation aborted")); return; }
          signal.addEventListener("abort", onAbort, { once: true });
        }

        child.stderr?.on("data", (c: Buffer) => { stderr += c.toString(); });

        rl.on("line", (line) => {
          if (!line.trim() || matchCount >= effectiveLimit) return;
          let event: any;
          try { event = JSON.parse(line); } catch { return; }
          if (event.type === "match") {
            matchCount++;
            const filePath = event.data?.path?.text;
            const lineNumber = event.data?.line_number;
            const lineText = event.data?.lines?.text;
            if (filePath && typeof lineNumber === "number") matches.push({ filePath, lineNumber, lineText });
            if (matchCount >= effectiveLimit) {
              matchLimitReached = true;
              killedDueToLimit = true;
              if (!child.killed) child.kill();
            }
          }
        });

        child.on("error", (err) => {
          rl.close();
          signal?.removeEventListener("abort", onAbort);
          rejectPromise(new Error(`Failed to run ripgrep: ${err.message}`));
        });

        child.on("close", async (code) => {
          rl.close();
          signal?.removeEventListener("abort", onAbort);
          if (signal?.aborted) { rejectPromise(new Error("Operation aborted")); return; }
          if (!killedDueToLimit && code !== 0 && code !== 1) {
            const errorMsg = stderr.trim() || `ripgrep exited with code ${code}`;
            rejectPromise(new Error(errorMsg));
            return;
          }
          if (matchCount === 0) { resolvePromise("No matches found"); return; }

          // Format matches
          const fileCache = new Map<string, string[]>();
          const getFileLines = async (fp: string): Promise<string[]> => {
            let lines = fileCache.get(fp);
            if (!lines) {
              try {
                const c = readFileSync(fp, "utf-8");
                lines = c.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
              } catch { lines = []; }
              fileCache.set(fp, lines);
            }
            return lines;
          };

          const outputLines: string[] = [];
          for (const match of matches) {
            if (contextLines === 0 && match.lineText !== undefined) {
              const relPath = formatPath(match.filePath);
              const sanitized = match.lineText.replace(/\r\n/g, "\n").replace(/\r/g, "").replace(/\n$/, "");
              const { text: truncatedText, wasTruncated } = truncateLine(sanitized);
              if (wasTruncated) linesTruncated = true;
              outputLines.push(`${relPath}:${match.lineNumber}: ${truncatedText}`);
            } else {
              const relPath = formatPath(match.filePath);
              const lines = await getFileLines(match.filePath);
              if (!lines.length) { outputLines.push(`${relPath}:${match.lineNumber}: (unable to read file)`); continue; }
              const start = contextLines > 0 ? Math.max(1, match.lineNumber - contextLines) : match.lineNumber;
              const end = contextLines > 0 ? Math.min(lines.length, match.lineNumber + contextLines) : match.lineNumber;
              for (let cur = start; cur <= end; cur++) {
                const lineText = lines[cur - 1] ?? "";
                const sanitized = lineText.replace(/\r/g, "");
                const { text: truncatedText, wasTruncated } = truncateLine(sanitized);
                if (wasTruncated) linesTruncated = true;
                if (cur === match.lineNumber) outputLines.push(`${relPath}:${cur}: ${truncatedText}`);
                else outputLines.push(`${relPath}-${cur}- ${truncatedText}`);
              }
            }
          }

          const rawOutput = outputLines.join("\n");
          const truncation = truncateHead(rawOutput, { maxLines: Number.MAX_SAFE_INTEGER });
          let output = truncation.content;
          const notices: string[] = [];
          if (matchLimitReached) notices.push(`${effectiveLimit} matches limit reached. Use limit=${effectiveLimit * 2} for more, or refine pattern`);
          if (truncation.truncated) notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
          if (linesTruncated) notices.push(`Some lines truncated to ${GREP_MAX_LINE_LENGTH} chars. Use read_file to see full lines`);
          if (notices.length > 0) output += `\n\n[${notices.join(". ")}]`;
          resolvePromise(output);
        });
      });
    }

    // Fallback to system grep
    return new Promise<string>((resolvePromise, rejectPromise) => {
      const grepArgs = ["-rn", "--color=never"];
      if (ignoreCase) grepArgs.push("-i");
      if (literal) grepArgs.push("-F");
      if (include) grepArgs.push(`--include=${include}`);
      grepArgs.push("--exclude-dir=node_modules", "--exclude-dir=.git");
      grepArgs.push("--", pattern, searchPath);

      const child = spawn("grep", grepArgs, { cwd: ROOT_CWD, stdio: ["ignore", "pipe", "pipe"] });
      let out = "";
      let count = 0;

      const onAbort = () => { if (!child.killed) child.kill(); };
      if (signal) {
        if (signal.aborted) { onAbort(); rejectPromise(new Error("Operation aborted")); return; }
        signal.addEventListener("abort", onAbort, { once: true });
      }

      child.stdout.on("data", (c: Buffer) => {
        out += c.toString();
        count = out.split("\n").length;
        if (count > effectiveLimit + 10) { if (!child.killed) child.kill(); }
      });
      child.on("error", (err) => {
        signal?.removeEventListener("abort", onAbort);
        rejectPromise(err);
      });
      child.on("close", () => {
        signal?.removeEventListener("abort", onAbort);
        if (signal?.aborted) { rejectPromise(new Error("Operation aborted")); return; }
        if (!out.trim()) { resolvePromise("No matches found"); return; }

        const lines = out.trim().split("\n").filter(Boolean);
        const hitLimit = lines.length > effectiveLimit;
        const outputLines = lines.slice(0, effectiveLimit).map((line) => {
          if (line.startsWith(searchPath)) line = line.slice(searchPath.length + 1);
          const { text, wasTruncated } = truncateLine(line);
          return text;
        });

        let output = outputLines.join("\n");
        if (hitLimit) output += `\n\n[${effectiveLimit} matches limit reached. Refine pattern for more specific results.]`;
        resolvePromise(truncateHead(output).content);
      });
    });
  },
};

// ============================================================================
// TOOL: run_command
// ============================================================================

const runCommandTool: ToolDefinition = {
  name: "run_command",
  description: `Execute a bash command in the current working directory. Returns stdout and stderr. Output is truncated to last ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first). If truncated, full output is saved to a temp file. Optionally provide a timeout in seconds.`,
  parameters: {
    type: "object",
    properties: {
      command: { type: "string", description: "Bash command to execute" },
      timeout: { type: "number", description: "Timeout in seconds (optional, no default timeout)" },
    },
    required: ["command"],
  },
  execute: async (args, signal?, onUpdate?) => {
    const ops = createLocalBashOperations();
    const command = args.command as string;
    const timeout = args.timeout as number | undefined;

    const output = new OutputAccumulator({ tempFilePrefix: "tradex-bash" });

    const handleData = (data: Buffer) => {
      output.append(data);
    };

    const finishOutput = async () => {
      output.finish();
      const snapshot = output.snapshot({ persistIfTruncated: true });
      await output.closeTempFile();
      return snapshot;
    };

    const formatOutput = (snapshot: Awaited<ReturnType<typeof finishOutput>>, emptyText = "(no output)") => {
      const truncation = snapshot.truncation;
      let text = snapshot.content || emptyText;
      if (truncation.truncated) {
        const startLine = truncation.totalLines - truncation.outputLines + 1;
        const endLine = truncation.totalLines;
        if (truncation.lastLinePartial) {
          const lastLineSize = formatSize(output.getLastLineBytes());
          text += `\n\n[Showing last ${formatSize(truncation.outputBytes)} of line ${endLine} (line is ${lastLineSize}). Full output: ${snapshot.fullOutputPath}]`;
        } else if (truncation.truncatedBy === "lines") {
          text += `\n\n[Showing lines ${startLine}-${endLine} of ${truncation.totalLines}. Full output: ${snapshot.fullOutputPath}]`;
        } else {
          text += `\n\n[Showing lines ${startLine}-${endLine} of ${truncation.totalLines} (${formatSize(DEFAULT_MAX_BYTES)} limit). Full output: ${snapshot.fullOutputPath}]`;
        }
      }
      return text;
    };

    try {
      let exitCode: number | null;
      try {
        const result = await ops.exec(command, ROOT_CWD, {
          onData: handleData,
          signal,
          timeout,
          env: process.env,
        });
        exitCode = result.exitCode;
      } catch (err) {
        const snapshot = await finishOutput();
        const text = formatOutput(snapshot, "");
        if (err instanceof Error && err.message === "aborted") {
          throw new Error(text ? `${text}\n\nCommand aborted` : "Command aborted");
        }
        if (err instanceof Error && err.message.startsWith("timeout:")) {
          const timeoutSecs = err.message.split(":")[1];
          throw new Error(text ? `${text}\n\nCommand timed out after ${timeoutSecs} seconds` : `Command timed out after ${timeoutSecs} seconds`);
        }
        throw err;
      }

      const snapshot = await finishOutput();
      const outputText = formatOutput(snapshot);
      if (exitCode !== 0 && exitCode !== null) {
        throw new Error(outputText ? `${outputText}\n\nCommand exited with code ${exitCode}` : `Command exited with code ${exitCode}`);
      }
      return outputText;
    } catch (err) {
      throw err;
    }
  },
};

// ============================================================================
// TOOL: read_skill_file
// ============================================================================

function createReadSkillFileTool(allowedPaths?: Set<string>): ToolDefinition {
  return {
    name: "read_skill_file",
    description: "Read the full content of a skill file by its absolute path. Use this when a skill's location is shown in <available_skills> and you need to load its full instructions.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute path to the skill file (from the <location> in available_skills)" },
      },
      required: ["path"],
    },
    execute: async (args) => {
      const filePath = args.path as string;
      if (!filePath.endsWith(".md")) {
        throw new Error("read_skill_file only reads .md skill files");
      }
      if (allowedPaths && !allowedPaths.has(filePath)) {
        throw new Error(`Access denied: "${filePath}" is not a registered skill file`);
      }
      const content = await readFile(filePath, "utf-8");
      const r = truncateHead(content);
      if (r.truncated) {
        return `${r.content}\n\n[Showing ${r.outputLines} of ${r.totalLines} lines.]`;
      }
      return r.content;
    },
  };
}

// ============================================================================
// REGISTRY FACTORY
// ============================================================================

/** Base filesystem tool definitions (without read_skill_file). */
export const filesystemTools: ToolDefinition[] = [
  readFileTool,
  writeFileTool,
  editFileTool,
  listDirectoryTool,
  findFilesTool,
  grepSearchTool,
  runCommandTool,
];

export interface FilesystemRegistryOptions {
  /** Set of absolute paths the read_skill_file tool is allowed to read. */
  allowedSkillPaths?: Set<string>;
}

/** Create a ToolRegistry with all filesystem tools pre-registered. */
export function createFilesystemRegistry(options?: FilesystemRegistryOptions): ToolRegistry {
  const registry = new ToolRegistry();
  for (const tool of filesystemTools) {
    registry.register(tool);
  }
  registry.register(createReadSkillFileTool(options?.allowedSkillPaths));
  return registry;
}

/** Register all filesystem tools into an existing registry. */
export function registerFilesystemTools(registry: ToolRegistry, options?: FilesystemRegistryOptions): void {
  for (const tool of filesystemTools) {
    registry.register(tool);
  }
  registry.register(createReadSkillFileTool(options?.allowedSkillPaths));
}
