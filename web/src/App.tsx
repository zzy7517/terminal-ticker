import { useEffect } from 'react';
import { useMarketStore } from './stores/marketStore';
import { useAgentStore } from './stores/agentStore';
import { useUiStore } from './stores/uiStore';
import { THEME_STORAGE_KEY } from './constants';
import { orderedGroups, readRouteFromHash } from './utils';
import { WorkspaceView } from './components/workspace';
import {
  SettingsFrame,
  ProviderSettingsPanel,
  AgentContextSettingsPanel,
  NewsSettingsPanel,
  MemorySettingsPanel,
  SocialSettingsPanel,
  CronSettingsPanel,
  McpSettingsPanel,
  BrowserSettingsPanel,
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

  // Auto-select first group/key when instruments change.
  const instrumentsSig = state?.instruments.map((i) => i.key).join(',') ?? '';
  useEffect(() => {
    if (!state) return;
    const ui = useUiStore.getState();
    const groups = orderedGroups(state);
    if (!ui.activeGroup || !state.groups[ui.activeGroup]) {
      ui.setActiveGroup(groups[0] ?? null);
    }
    if (!ui.selectedKey || !state.quotes[ui.selectedKey]) {
      const firstKey = groups.flatMap((group) => state.groups[group] ?? [])[0];
      ui.setSelectedKey(firstKey ?? null);
    }
  }, [instrumentsSig]);

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
        ) : route.section === 'memory' ? (
          <MemorySettingsPanel />
        ) : route.section === 'cron' ? (
          <CronSettingsPanel />
        ) : route.section === 'social' ? (
          <SocialSettingsPanel />
        ) : route.section === 'mcp' ? (
          <McpSettingsPanel />
        ) : route.section === 'browser' ? (
          <BrowserSettingsPanel />
        ) : (
          <WatchlistSettingsPanel />
        )}
      </SettingsFrame>
    );
  }

  return <WorkspaceView />;
}
