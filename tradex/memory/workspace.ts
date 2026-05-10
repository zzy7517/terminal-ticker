export interface MemoryWorkspaceChange {
  path: string;
  status: "added" | "modified" | "deleted";
}

export interface MemoryWorkspaceDiff {
  changes: MemoryWorkspaceChange[];
}

export function hasChanges(diff: MemoryWorkspaceDiff): boolean {
  return diff.changes.length > 0;
}
