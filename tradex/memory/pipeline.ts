import { MemoryConfig } from "../config/index.js";
import { ensureMemoryLayout } from "./paths.js";
import { MemoryStateStore } from "./state.js";

export class MemoryPipeline {
  readonly config: MemoryConfig;
  readonly state: MemoryStateStore;

  constructor(input: { config: MemoryConfig; state?: MemoryStateStore }) {
    this.config = input.config;
    this.state = input.state ?? new MemoryStateStore();
    ensureMemoryLayout(input.config.storagePath);
  }

  kickoffStartup(): void {
    // Startup extraction is intentionally lazy in the TS runtime.
  }

  async shutdown(): Promise<void> {
    this.state.close();
  }

  async enqueueManualNote(input: { noteId: string; payload: string | Record<string, unknown> }): Promise<void> {
    this.state.enqueueSource({ sourceType: "manual_note", sourceKey: input.noteId, payloadJson: typeof input.payload === "string" ? input.payload : JSON.stringify(input.payload) });
  }

  enqueueTradeEvent(input: { tradeId: number; updatedAt?: number | null }): void {
    this.state.enqueueSource({ sourceType: "trade", sourceKey: String(input.tradeId), payloadJson: JSON.stringify(input) });
  }

  async runOnce(): Promise<void> {}
  async runStage1UntilIdle(): Promise<void> {}
  async runPhase2Once(): Promise<boolean> {
    return false;
  }
}
