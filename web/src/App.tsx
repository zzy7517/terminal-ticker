import { useEffect } from 'react';
import { useMarketStore } from './stores/marketStore';
import { useAgentStore } from './stores/agentStore';
import { useUiStore } from './stores/uiStore';
import { AGENT_PROVIDER_OPTIONS, THEME_STORAGE_KEY } from './constants';
import { orderedGroups, readRouteFromHash } from './utils';
import { WorkspaceView } from './components/workspace';
import {
  SettingsFrame,
  ProviderSettingsPanel,
  AgentContextSettingsPanel,
  NewsSettingsPanel,
  SocialSettingsPanel,
  WatchlistSettingsPanel,
} from './components/settings';

export default function App() {
  const route = useUiStore((s) => s.route);
  const theme = useUiStore((s) => s.theme);
  const state = useMarketStore((s) => s.state);

  // Apply theme to DOM on mount and changes.
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try { window.localStorage.setItem(THEME_STORAGE_KEY, theme); } catch {}
  }, [theme]);

  // Sync route from hash changes.
  useEffect(() => {
    const syncRoute = () => useUiStore.getState().setRoute(readRouteFromHash());
    window.addEventListener('hashchange', syncRoute);
    syncRoute();
    return () => window.removeEventListener('hashchange', syncRoute);
  }, []);

  // Initialize WebSocket connection and initial state fetch.
  useEffect(() => {
    return useMarketStore.getState().initSocket();
  }, []);

  // Initialize agent sessions on mount.
  useEffect(() => {
    return useAgentStore.getState().initSessions();
  }, []);

  // Auto-select first group/key when state arrives.
  const selectedKey = useUiStore((s) => s.selectedKey);
  const activeGroup = useUiStore((s) => s.activeGroup);
  useEffect(() => {
    if (!state) return;
    const groups = orderedGroups(state);
    if (!activeGroup || !state.groups[activeGroup]) {
      useUiStore.getState().setActiveGroup(groups[0] ?? null);
    }
    if (!selectedKey || !state.quotes[selectedKey]) {
      const firstKey = groups.flatMap((group) => state.groups[group] ?? [])[0];
      useUiStore.getState().setSelectedKey(firstKey ?? null);
    }
  }, [activeGroup, selectedKey, state]);

  // Filter agent candidate keys when instruments change.
  useEffect(() => {
    if (!state) return;
    const validKeys = state.instruments.map((i) => i.key);
    useAgentStore.getState().filterCandidateKeys(validKeys);
  }, [state]);

  // Sync agent provider/model with profile changes.
  const profilesSig = state?.config.agent.providerProfiles
    ? JSON.stringify(state.config.agent.providerProfiles)
    : '';
  useEffect(() => {
    if (!state?.config.agent.providerProfiles) return;
    useAgentStore.getState().syncProviderModel(state.config.agent.providerProfiles);
  }, [profilesSig]);

  // Fetch models for newly enabled providers.
  useEffect(() => {
    if (!state?.config.agent.providerProfiles) return;
    useAgentStore.getState().fetchModelsForEnabledProviders(state.config.agent.providerProfiles);
  }, [profilesSig]);

  if (route.view === 'settings') {
    return (
      <SettingsFrame>
        {route.section === 'providers' ? (
          <ProviderSettingsPanel />
        ) : route.section === 'agent-context' ? (
          <AgentContextSettingsPanel />
        ) : route.section === 'news' ? (
          <NewsSettingsPanel />
        ) : route.section === 'social' ? (
          <SocialSettingsPanel />
        ) : (
          <WatchlistSettingsPanel />
        )}
      </SettingsFrame>
    );
  }

  return <WorkspaceView />;
}
