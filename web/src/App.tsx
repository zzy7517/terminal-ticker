import { useEffect } from 'react';
import { useMarketStore } from './stores/marketStore';
import { useAgentStore } from './stores/agentStore';
import { useUiStore } from './stores/uiStore';

import { orderedGroups, readRouteFromHash } from './utils';
import { WorkspaceView } from './components/workspace';
import {
  SettingsFrame,
  ProviderSettingsPanel,
  AgentContextSettingsPanel,
  AgentsSettingsPanel,
  NewsSettingsPanel,
  MemorySettingsPanel,
  SocialSettingsPanel,
  CronSettingsPanel,
  McpSettingsPanel,
  BrowserSettingsPanel,
  ProxySettingsPanel,
  WatchlistSettingsPanel,
  OptionsSettingsPanel,
} from './components/settings';

export default function App() {
  const route = useUiStore((s) => s.route);
  const state = useMarketStore((s) => s.state);

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

  // Load the backend-owned model catalog once on startup.
  useEffect(() => {
    void useAgentStore.getState().refreshModelRegistry();
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

  // Provider configuration reloads create a new registry generation.
  const profilesSig = state?.config.agent.providerProfiles
    ? JSON.stringify(state.config.agent.providerProfiles)
    : '';
  useEffect(() => {
    if (!state?.config.agent.providerProfiles) return;
    void useAgentStore.getState().refreshModelRegistry();
  }, [profilesSig]);

  if (route.view === 'settings') {
    return (
      <SettingsFrame>
        {route.section === 'providers' ? (
          <ProviderSettingsPanel />
        ) : route.section === 'agents' ? (
          <AgentsSettingsPanel />
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
        ) : route.section === 'options' ? (
          <OptionsSettingsPanel />
        ) : route.section === 'proxy' ? (
          <ProxySettingsPanel />
        ) : (
          <WatchlistSettingsPanel />
        )}
      </SettingsFrame>
    );
  }

  return <WorkspaceView />;
}
