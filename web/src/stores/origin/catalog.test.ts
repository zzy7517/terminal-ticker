import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentRuntimeStatus, OriginDraftConfig } from '../../types';
import { useAgentStore } from '../agentStore';
import {
  canonicalizeAvailableOriginConfig,
  originCatalogReadyForConfig,
  useOriginCatalogStore,
} from './catalog';

const initialCatalogState = useOriginCatalogStore.getState();
const initialAgentState = useAgentStore.getState();

afterEach(() => {
  useOriginCatalogStore.setState(initialCatalogState, true);
  useAgentStore.setState({
    modelRegistry: initialAgentState.modelRegistry,
    refreshModelRegistry: initialAgentState.refreshModelRegistry,
  });
});

describe('Origin catalog source', () => {
  it('fails closed instead of switching Runtime when the Pi registry cannot load', async () => {
    const refreshModelRegistry = vi.fn(async () => undefined);
    useAgentStore.setState({ modelRegistry: null, refreshModelRegistry });
    useOriginCatalogStore.setState({
      loaded: true,
      runtimesLoaded: true,
      claudeModelsLoaded: true,
      cursorModelsLoaded: true,
      runtimes: runtimes(),
    });
    const selected: OriginDraftConfig = {
      runtime: 'pi', provider: 'removed', model: 'removed-model', reasoningEffort: null,
    };

    await expect(canonicalizeAvailableOriginConfig(selected)).rejects.toThrow(
      'Origin catalog is unavailable for the selected Runtime',
    );
    expect(refreshModelRegistry).toHaveBeenCalledOnce();
  });

  it('does not normalize a custom external model from a partial catalog', () => {
    useOriginCatalogStore.setState({
      loaded: true,
      runtimesLoaded: true,
      claudeModelsLoaded: true,
      cursorModelsLoaded: false,
      runtimes: runtimes(),
    });

    expect(originCatalogReadyForConfig({
      runtime: 'cursor', provider: null, model: 'composer-1.5', reasoningEffort: null,
    })).toBe(false);
  });
});

function runtimes(): AgentRuntimeStatus[] {
  return (['pi', 'claude-code', 'cursor'] as const).map((id) => ({
    id,
    available: true,
    version: null,
    error: null,
    capabilities: { streaming: true, abort: true, resume: true, imageInput: true, toolProgress: true },
  }));
}
