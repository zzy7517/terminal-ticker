/** Shared Origin catalog resources for UI selection and programmatic sends. */
import { create } from 'zustand';
import { fetchAgentRuntimes, fetchClaudeCodeModels, fetchCursorModels } from '../../api';
import {
  buildOriginCatalog,
  normalizeOriginConfig,
  type OriginCatalog,
} from '../../chat/originCatalog';
import type {
  AgentRuntimeStatus,
  ClaudeCodeModelsResponse,
  CursorModelsResponse,
  OriginDraftConfig,
} from '../../types';
import { useAgentStore } from '../agentStore';
import { useMarketStore } from '../marketStore';

interface OriginCatalogResourceState {
  runtimes: AgentRuntimeStatus[];
  claudeModels: ClaudeCodeModelsResponse | null;
  cursorModels: CursorModelsResponse | null;
  generation: number;
  loaded: boolean;
  loading: boolean;
  runtimesLoaded: boolean;
  claudeModelsLoaded: boolean;
  cursorModelsLoaded: boolean;
  ensureLoaded(): Promise<void>;
  refresh(): Promise<void>;
}

let catalogRequest: Promise<void> | null = null;

export const useOriginCatalogStore = create<OriginCatalogResourceState>((set, get) => ({
  runtimes: [],
  claudeModels: null,
  cursorModels: null,
  generation: 0,
  loaded: false,
  loading: false,
  runtimesLoaded: false,
  claudeModelsLoaded: false,
  cursorModelsLoaded: false,

  ensureLoaded: async () => {
    const state = get();
    if (state.runtimesLoaded && state.claudeModelsLoaded && state.cursorModelsLoaded) return;
    await get().refresh();
  },

  refresh: async () => {
    if (catalogRequest) return catalogRequest;
    set({ loading: true });
    catalogRequest = Promise.allSettled([
      fetchAgentRuntimes(),
      fetchClaudeCodeModels(),
      fetchCursorModels(),
    ]).then(([runtimeResult, claudeResult, cursorResult]) => {
      set((state) => ({
        runtimes: runtimeResult.status === 'fulfilled' ? runtimeResult.value.runtimes : state.runtimes,
        claudeModels: claudeResult.status === 'fulfilled' ? claudeResult.value : state.claudeModels,
        cursorModels: cursorResult.status === 'fulfilled' ? cursorResult.value : state.cursorModels,
        generation: state.generation + 1,
        loaded: true,
        runtimesLoaded: state.runtimesLoaded || runtimeResult.status === 'fulfilled',
        claudeModelsLoaded: state.claudeModelsLoaded || claudeResult.status === 'fulfilled',
        cursorModelsLoaded: state.cursorModelsLoaded || cursorResult.status === 'fulfilled',
      }));
    }).finally(() => {
      catalogRequest = null;
      set({ loading: false });
    });
    return catalogRequest;
  },
}));

export function currentOriginCatalog(): OriginCatalog {
  const resources = useOriginCatalogStore.getState();
  return buildOriginCatalog({
    registry: useAgentStore.getState().modelRegistry,
    agentConfig: useMarketStore.getState().state?.config.agent ?? null,
    runtimes: resources.runtimes,
    claudeModels: resources.claudeModels,
    cursorModels: resources.cursorModels,
  });
}

export function originCatalogReadyForConfig(config: OriginDraftConfig): boolean {
  const resources = useOriginCatalogStore.getState();
  if (!resources.runtimesLoaded) return false;
  if (config.runtime === 'pi') return Boolean(useAgentStore.getState().modelRegistry);
  if (config.runtime === 'claude-code') return !config.model || resources.claudeModelsLoaded;
  return !config.model || resources.cursorModelsLoaded;
}

/** Resolves remembered or programmatic config against the latest available catalog. */
export async function canonicalizeAvailableOriginConfig(
  config: OriginDraftConfig,
): Promise<OriginDraftConfig> {
  await Promise.all([
    useOriginCatalogStore.getState().ensureLoaded(),
    useAgentStore.getState().modelRegistry
      ? Promise.resolve()
      : useAgentStore.getState().refreshModelRegistry(),
  ]);
  const resources = useOriginCatalogStore.getState();
  if (!originCatalogReadyForConfig(config)) throw new Error('Origin catalog is unavailable for the selected Runtime');
  const catalog = currentOriginCatalog();
  const family = catalog.families.find((candidate) => candidate.runtime === config.runtime);
  if (!family?.available) throw new Error(family?.unavailableReason || 'Origin runtime is unavailable');
  const normalized = normalizeOriginConfig(config, catalog);
  if (normalized.runtime !== config.runtime) throw new Error('Origin runtime is unavailable');
  return normalized;
}
