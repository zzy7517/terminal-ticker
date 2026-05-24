import { LocalMemoryBackend } from "./backend.js";
import { ToolRegistry, jsonOutput } from "../agent/tools/registry.js";

export function buildMemoryTools(input: string | null | { root?: string | null; allowWriteNotes?: boolean } = null): ToolRegistry {
  const memoryRoot = typeof input === "object" && input !== null ? input.root : input;
  const allowWriteNotes = typeof input === "object" && input !== null ? input.allowWriteNotes === true : true;
  const backend = new LocalMemoryBackend(memoryRoot);
  const registry = new ToolRegistry();
  registry.register({
    name: "list_memories",
    description: "List local memory files.",
    parameters: { type: "object", properties: { path: { type: ["string", "null"] }, limit: { type: "integer" } } },
    execute: ({ path, limit }) => jsonOutput({ items: backend.list({ path: path ? String(path) : null, limit: Number(limit) || 100 }) }),
  });
  registry.register({
    name: "read_memory",
    description: "Read a local memory file.",
    parameters: { type: "object", properties: { path: { type: "string" }, max_chars: { type: "integer" } }, required: ["path"] },
    execute: ({ path, max_chars }) => jsonOutput(backend.read({ path: String(path), maxChars: Number(max_chars) || 20_000 })),
  });
  registry.register({
    name: "search_memories",
    description: "Search local memory files.",
    parameters: { type: "object", properties: { query: { type: "string" }, path: { type: ["string", "null"] }, limit: { type: "integer" } }, required: ["query"] },
    execute: ({ query, path, limit }) => jsonOutput({ matches: backend.search({ query: String(query), path: path ? String(path) : null, limit: Number(limit) || 50 }) }),
  });
  registry.register({
    name: "write_memory_note",
    description: "Write a user-requested ad-hoc memory note for future Phase 2 consolidation. Use only when the user explicitly asks to remember or update memory.",
    parameters: {
      type: "object",
      properties: {
        content: { type: "string", description: "The durable note content to remember. Do not include secrets." },
        slug: { type: ["string", "null"], description: "Optional short filename slug." },
      },
      required: ["content"],
    },
    execute: ({ content, slug }) => jsonOutput(backend.writeAdHocNote({
      allowWrite: allowWriteNotes,
      content: String(content || ""),
      slug: slug ? String(slug) : null,
    })),
  });
  return registry;
}
