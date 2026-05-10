export interface MemoryCitation {
  path: string;
  quote: string;
}

export function formatCitation(citation: MemoryCitation): string {
  return `${citation.path}: ${citation.quote}`;
}
