import { useState } from 'react';
import {
  Bot,
  CalendarDays,
  Clock,
  LineChart,
  Newspaper,
  WalletCards,
} from 'lucide-react';
import './WorkspaceView.css';
import { useMarketStore } from '../../stores/marketStore';
import { useUiStore } from '../../stores/uiStore';

import { WatchlistSidebar } from './WatchlistSidebar';
import { AgentSessionHistoryList } from './AgentSessionHistoryList';
import { AgentSessionPanel } from './AgentSessionPanel';
import { NewsPanel } from './NewsPanel';
import { PositionsPanel } from './PositionsPanel';
import { CronPanel } from './CronPanel';
import { CalendarPanel } from './CalendarPanel';
import { OptionsPanel } from './OptionsPanel';
import { AgentPicker } from './AgentPicker';
import { useAgentStore } from '../../stores/agentStore';

export function WorkspaceView() {
  const state = useMarketStore((s) => s.state);
  const activeTab = useUiStore((s) => s.activeWorkspace);
  const [agentPickerOpen, setAgentPickerOpen] = useState(false);
  const resetAgentConversation = useAgentStore((s) => s.resetAgentConversation);

  const jin10Available = Boolean(state?.jin10?.status?.available && state?.config?.jin10?.enabled);
  return (
    <main className="workspace-page">
      <header className="topbar">
        <div className="topbar-left">
          <span className="workspace-title-icon" aria-hidden="true">
            {activeTab === 'agent' ? <Bot size={17} />
              : activeTab === 'market' ? <LineChart size={17} />
              : activeTab === 'news' ? <Newspaper size={17} />
              : activeTab === 'calendar' ? <CalendarDays size={17} />
              : activeTab === 'cron' ? <Clock size={17} />
              : <WalletCards size={17} />}
          </span>
          <div>
            <h1>{activeTab === 'market' ? 'Market' : activeTab.charAt(0).toUpperCase() + activeTab.slice(1)}</h1>
            <p className="workspace-subtitle">
              {activeTab === 'agent' ? 'Research and analysis workspace'
                : activeTab === 'market' ? 'Watchlist and live market overview'
                : 'Tradex workspace'}
            </p>
          </div>
        </div>
      </header>

      <section className="workspace">
        <section className="main-content">
          {activeTab === 'market' && (
            <div className="market-workspace">
              <WatchlistSidebar mode="workspace" />
            </div>
          )}
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
      {agentPickerOpen && <AgentPicker onClose={() => setAgentPickerOpen(false)} onSelect={(agent) => { setAgentPickerOpen(false); void resetAgentConversation(agent.id); }} />}
    </main>
  );
}
