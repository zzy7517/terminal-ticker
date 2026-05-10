export interface MemoryRuntimePolicy {
  enabled: boolean;
  runExtraction: boolean;
  runConsolidation: boolean;
}

export const MemoryPolicies = {
  normal(): MemoryRuntimePolicy {
    return { enabled: true, runExtraction: true, runConsolidation: true };
  },
  consolidation(): MemoryRuntimePolicy {
    return { enabled: true, runExtraction: false, runConsolidation: true };
  },
  disabled(): MemoryRuntimePolicy {
    return { enabled: false, runExtraction: false, runConsolidation: false };
  },
};
