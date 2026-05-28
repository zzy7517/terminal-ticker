import { useState } from 'react';
import {
  Settings,
  Zap,
} from 'lucide-react';
import './WorkspaceView.css';
import { useMarketStore } from '../../stores/marketStore';
import { useUiStore } from '../../stores/uiStore';

import { ConnectionBadge } from './ConnectionBadge';
import { WatchlistSidebar } from './WatchlistSidebar';
import { AgentSessionHistoryList } from './AgentSessionHistoryList';
import { AgentSessionPanel } from './AgentSessionPanel';
import { NewsPanel } from './NewsPanel';
import { SocialFeedPanel } from './SocialFeedPanel';
import { PositionsPanel } from './PositionsPanel';
import { CronPanel } from './CronPanel';
import { CalendarPanel } from './CalendarPanel';
import { RegimeHUD } from './RegimeHUD';
import { FeedStatusBar } from './FeedStatusBar';
import { PipelineDashboard } from './PipelineDashboard';
import { EvolutionPanel } from './EvolutionPanel';

export function WorkspaceView() {
  const state = useMarketStore((s) => s.state);
  const socketStatus = useMarketStore((s) => s.socketStatus);

  const openSettings = useUiStore((s) => s.openSettings);

  const [activeTab, setActiveTab] = useState<'agent' | 'news' | 'social' | 'calendar' | 'positions' | 'cron' | 'pipeline' | 'evolution'>('agent');

  const jin10Available = Boolean(state?.jin10?.status?.available && state?.config?.jin10?.enabled);

  return (
    <main className="app-shell app-shell--with-sidebar">
      {/* Left sidebar: persistent watchlist */}
      <WatchlistSidebar />

      <div className="app-main">
      <header className="topbar">
        <div className="topbar-left">
          <div className="brand-lockup">
            <div className="brand-mark" aria-hidden="true">
              <Zap size={21} />
            </div>
            <div>
              <h1>tradex</h1>
            </div>
          </div>
        </div>
        <div className="topbar-right">
          <ConnectionBadge socketStatus={socketStatus} streamStatus={state?.streamStatus ?? 'idle'} />
          <button className="shell-button" type="button" onClick={() => openSettings()}>
            <Settings size={16} />
            Settings
          </button>
        </div>
      </header>

      <RegimeHUD />

      <div className="workspace-tabs" role="tablist">
        {(['agent', 'pipeline', 'evolution', 'news', 'social', ...(jin10Available ? ['calendar' as const] : []), 'positions', 'cron'] as const).map((tab) => (
          <button
            key={tab}
            type="button"
            role="tab"
            aria-selected={activeTab === tab}
            className={`workspace-tab ${activeTab === tab ? 'active' : ''}`}
            onClick={() => setActiveTab(tab)}
          >
            {tab === 'calendar' ? 'Calendar' : tab.charAt(0).toUpperCase() + tab.slice(1)}
          </button>
        ))}
      </div>

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
                jin10Available={jin10Available}
              />

            </div>
          )}

          {activeTab === 'social' && <SocialFeedPanel />}

          {activeTab === 'calendar' && (
            <div className="calendar-tab-panel">
              <CalendarPanel
                events={state?.jin10?.calendar ?? []}
                jin10Available={jin10Available}
              />
            </div>
          )}

          {activeTab === 'pipeline' && <PipelineDashboard />}
          {activeTab === 'evolution' && <EvolutionPanel />}
          {activeTab === 'positions' && <PositionsPanel />}
          {activeTab === 'cron' && <CronPanel />}
        </section>
      </section>
      <FeedStatusBar />
      </div>{/* end .app-main */}
    </main>
  );
}
