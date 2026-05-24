export class MemoryRuntimePolicy {
  readonly enabled: boolean;
  readonly generateMemories: boolean;
  readonly useMemories: boolean;
  readonly ephemeral: boolean;
  readonly disableOnExternalContext: boolean;

  private constructor(input: { enabled: boolean; generateMemories: boolean; useMemories: boolean; ephemeral: boolean; disableOnExternalContext?: boolean }) {
    this.enabled = input.enabled;
    this.generateMemories = input.generateMemories;
    this.useMemories = input.useMemories;
    this.ephemeral = input.ephemeral;
    this.disableOnExternalContext = input.disableOnExternalContext ?? false;
  }

  static normal(): MemoryRuntimePolicy {
    return new MemoryRuntimePolicy({ enabled: true, generateMemories: true, useMemories: true, ephemeral: false });
  }

  static consolidation(): MemoryRuntimePolicy {
    return new MemoryRuntimePolicy({ enabled: true, generateMemories: false, useMemories: false, ephemeral: true });
  }

  static disabled(): MemoryRuntimePolicy {
    return new MemoryRuntimePolicy({ enabled: false, generateMemories: false, useMemories: false, ephemeral: false });
  }
}
