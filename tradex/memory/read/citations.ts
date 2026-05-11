const CITATION_BLOCK_RE = /<oai-mem-citation>\s*([\s\S]*?)\s*<\/oai-mem-citation>/;
const SECTION_RE = /<(?<name>citation_entries|rollout_ids)>\s*(?<body>[\s\S]*?)\s*<\/\k<name>>/g;
const ENTRY_RE = /^(?<path>[^:\n]+):(?<start>\d+)-(?<end>\d+)\|note=\[(?<note>[^\]\n]*)\]$/;
const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export interface MemoryCitationEntry {
  filePath: string;
  lineStart: number;
  lineEnd: number;
  note: string;
}

export interface MemoryCitations {
  entries: MemoryCitationEntry[];
  rolloutIds: string[];
}

export function parseMemoryCitations(content: string): MemoryCitations | null {
  const blockMatch = CITATION_BLOCK_RE.exec(content || "");
  if (!blockMatch) return null;

  const sections: Record<string, string> = {};
  let sectionMatch: RegExpExecArray | null;
  const sectionRe = new RegExp(SECTION_RE.source, "g");
  while ((sectionMatch = sectionRe.exec(blockMatch[1])) !== null) {
    if (sectionMatch.groups) {
      sections[sectionMatch.groups.name] = sectionMatch.groups.body;
    }
  }

  const entries: MemoryCitationEntry[] = [];
  for (const line of (sections.citation_entries ?? "").split("\n")) {
    const parsed = parseEntry(line.trim());
    if (parsed) entries.push(parsed);
  }

  const seen = new Set<string>();
  const rolloutIds: string[] = [];
  for (const line of (sections.rollout_ids ?? "").split("\n")) {
    const trimmed = line.trim();
    if (UUID_RE.test(trimmed) && !seen.has(trimmed)) {
      seen.add(trimmed);
      rolloutIds.push(trimmed);
    }
  }

  if (entries.length === 0 && rolloutIds.length === 0) return null;
  return { entries, rolloutIds };
}

function parseEntry(line: string): MemoryCitationEntry | null {
  if (!line) return null;
  const match = ENTRY_RE.exec(line);
  if (!match?.groups) return null;
  const lineStart = parseInt(match.groups.start, 10);
  const lineEnd = parseInt(match.groups.end, 10);
  if (lineEnd < lineStart) return null;
  return {
    filePath: match.groups.path.trim(),
    lineStart,
    lineEnd,
    note: match.groups.note.trim(),
  };
}

export function formatCitation(citation: MemoryCitationEntry): string {
  return `${citation.filePath}:${citation.lineStart}-${citation.lineEnd}|note=[${citation.note}]`;
}
