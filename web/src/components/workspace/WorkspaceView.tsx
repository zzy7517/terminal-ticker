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
import { OptionsPanel } from './OptionsPanel';
import { AgentPicker } from './AgentPicker';
import { useAgentStore } from '../../stores/agentStore';

export function WorkspaceView() {
  const state = useMarketStore((s) => s.state);
  const socketStatus = useMarketStore((s) => s.socketStatus);

  const openSettings = useUiStore((s) => s.openSettings);

  const [activeTab, setActiveTab] = useState<'agent' | 'news' | 'social' | 'calendar' | 'positions' | 'options' | 'cron'>('agent');
  const [agentPickerOpen, setAgentPickerOpen] = useState(false);
  const resetAgentConversation = useAgentStore((s) => s.resetAgentConversation);

  const jin10Available = Boolean(state?.jin10?.status?.available && state?.config?.jin10?.enabled);
  const optionsAvailable = Boolean((state as any)?.options?.snapshots && Object.keys((state as any).options.snapshots).length > 0);

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

      <div className="workspace-tabs" role="tablist">
        {(['agent', 'news', 'social', ...(jin10Available ? ['calendar' as const] : []), 'positions', ...(optionsAvailable ? ['options' as const] : []), 'cron'] as const).map((tab) => (
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
              <AgentSessionHistoryList onNewSession={() => setAgentPickerOpen(true)} />
              <AgentSessionPanel
                providerProfiles={state?.config.agent.providerProfiles ?? {}}
                disabled={!state}
                onNewSession={() => setAgentPickerOpen(true)}
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

          {activeTab === 'positions' && <PositionsPanel />}
          {activeTab === 'options' && <OptionsPanel />}
          {activeTab === 'cron' && <CronPanel />}
        </section>
      </section>
      </div>{/* end .app-main */}
      {agentPickerOpen && <AgentPicker onClose={() => setAgentPickerOpen(false)} onSelect={(agent) => { setAgentPickerOpen(false); void resetAgentConversation(agent.id); }} />}
    </main>
  );
}
