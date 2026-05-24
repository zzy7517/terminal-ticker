import { useState } from 'react';
import {
  BarChart3,
  Moon,
  Settings,
  Sun,
  Zap,
} from 'lucide-react';
import { useMarketStore } from '../../stores/marketStore';
import { useUiStore } from '../../stores/uiStore';
import { THEME_LABELS } from '../../constants';
import type { ThemeName } from '../../constants';
import { nextTheme } from '../../utils';
import { ConnectionBadge } from './ConnectionBadge';
import { WatchlistDrawer } from './WatchlistDrawer';
import { AgentSessionHistoryList } from './AgentSessionHistoryList';
import { AgentSessionPanel } from './AgentSessionPanel';
import { NewsPanel } from './NewsPanel';
import { SocialFeedPanel } from './SocialFeedPanel';
import { PositionsPanel } from './PositionsPanel';
import { CronPanel } from './CronPanel';

export function WorkspaceView() {
  const state = useMarketStore((s) => s.state);
  const socketStatus = useMarketStore((s) => s.socketStatus);

  const theme = useUiStore((s) => s.theme);
  const toggleWatchlist = useUiStore((s) => s.toggleWatchlist);
  const openSettings = useUiStore((s) => s.openSettings);

  const nextThemeName: ThemeName = nextTheme(theme);

  const [activeTab, setActiveTab] = useState<'agent' | 'news' | 'social' | 'positions' | 'cron'>('agent');

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="topbar-left">
          <button
            aria-label="Toggle watchlist"
            className="shell-button icon"
            onClick={toggleWatchlist}
            title="Watchlist (⌘B)"
            type="button"
          >
            <BarChart3 size={18} />
          </button>
          <div className="brand-lockup">
            <div className="brand-mark" aria-hidden="true">
              <Zap size={21} />
            </div>
            <div>
              <div className="eyebrow">Local Price Action Agent</div>
              <h1>tradex</h1>
            </div>
          </div>
        </div>
        <div className="topbar-right">
          <ConnectionBadge socketStatus={socketStatus} streamStatus={state?.streamStatus ?? 'idle'} />
          <button
            aria-label={`Switch to ${THEME_LABELS[nextThemeName]} mode`}
            aria-pressed={theme === 'dark'}
            className="shell-button theme-toggle"
            onClick={() => useUiStore.getState().toggleTheme()}
            title={`Switch to ${THEME_LABELS[nextThemeName]}`}
            type="button"
          >
            {theme === 'dark' ? <Sun size={16} /> : <Moon size={16} />}
            <span>{THEME_LABELS[nextThemeName]}</span>
          </button>
          <button className="shell-button" type="button" onClick={() => openSettings()}>
            <Settings size={16} />
            Settings
          </button>
        </div>
      </header>

      <div className="workspace-tabs" role="tablist">
        {(['agent', 'news', 'social', 'positions', 'cron'] as const).map((tab) => (
          <button
            key={tab}
            type="button"
            role="tab"
            aria-selected={activeTab === tab}
            className={`workspace-tab ${activeTab === tab ? 'active' : ''}`}
            onClick={() => setActiveTab(tab)}
          >
            {tab.charAt(0).toUpperCase() + tab.slice(1)}
          </button>
        ))}
      </div>

      <WatchlistDrawer />

      <section className="workspace">
        <section className="main-content">
          {activeTab === 'agent' && (
            <div className="agent-tab-layout">
              <AgentSessionHistoryList />
              <AgentSessionPanel
                providerProfiles={state?.config.agent.providerProfiles ?? {}}
                disabled={!state}
              />
            </div>
          )}

          {activeTab === 'news' && (
            <div className="news-tab-panel">
              <NewsPanel
                items={state?.recentNews ?? []}
                lastStatus={state?.newsStatus?.lastStatus}
                lastError={state?.newsStatus?.lastError ?? null}
              />
            </div>
          )}

          {activeTab === 'social' && <SocialFeedPanel />}
          {activeTab === 'positions' && <PositionsPanel />}
          {activeTab === 'cron' && <CronPanel />}
        </section>
      </section>
    </main>
  );
}
