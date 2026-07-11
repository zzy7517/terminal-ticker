import type { MemoryConfig } from "../config/index.js";
import type { ToolRegistry } from "../agent/tools/registry.js";
import { buildMemoryDeveloperInstructions, parseMemoryCitations } from "./read/index.js";
import { buildMemoryTools } from "./tools.js";
import type { MemoryPipeline } from "./pipeline.js";

export interface MemoryPort {
  getPromptContext(): string | null | Promise<string | null>;
  buildTools(): ToolRegistry | null | Promise<ToolRegistry | null>;
  recordAssistantResponse(content: string): void | Promise<void>;
}

export class LocalMemoryPort implements MemoryPort {
  constructor(
    private readonly config: MemoryConfig,
    private readonly getPipeline: () => MemoryPipeline | null,
  ) {}

  getPromptContext(): string | null {
    if (!this.config.enabled || !this.config.useMemories) return null;
    return buildMemoryDeveloperInstructions(this.config.storagePath);
  }

  buildTools(): ToolRegistry {
    return buildMemoryTools({
      root: this.config.storagePath,
      allowWriteNotes: this.config.enabled && this.config.generateMemories,
    });
  }

  recordAssistantResponse(content: string): void {
    const citations = parseMemoryCitations(content);
    const pipeline = this.getPipeline();
    if (!citations || !pipeline) return;

    const seenPaths = new Set<string>();
    for (const entry of citations.entries) {
      if (seenPaths.has(entry.filePath)) continue;
      seenPaths.add(entry.filePath);
      try {
        pipeline.state.recordUsage({ filePath: entry.filePath, usageKind: "citation" });
      } catch (error) {
        console.warn("failed recording memory citation usage", error);
      }
    }

    if (citations.rolloutIds.length > 0) {
      try {
        pipeline.state.recordSourceRefUsage({
          sourceRefs: citations.rolloutIds,
          usageKind: "citation",
        });
      } catch (error) {
        console.warn("failed recording memory rollout usage", error);
      }
    }
  }
}
