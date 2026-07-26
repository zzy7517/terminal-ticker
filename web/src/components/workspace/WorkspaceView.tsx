import {
  CalendarDays,
  Clock,
  Globe,
  LineChart,
  Newspaper,
  WalletCards,
} from 'lucide-react';
import './WorkspaceView.css';
import { useMarketStore } from '../../stores/marketStore';
import { useUiStore } from '../../stores/uiStore';

import { WatchlistSidebar } from './WatchlistSidebar';
import { AgentDirectMessageList } from './AgentDirectMessageList';
import { AgentSessionPanel } from './AgentSessionPanel';
import { OriginSessionPanel } from './OriginSessionPanel';
import { NewsPanel } from './NewsPanel';
import { PositionsPanel } from './PositionsPanel';
import { CronPanel } from './CronPanel';
import { CalendarPanel } from './CalendarPanel';
import { OptionsPanel } from './OptionsPanel';
import { MacroPanel } from './MacroPanel';
import { useChatStore } from '../../stores/chatStore';
import { ChannelPanel } from '../chat/ChannelPanel';
import { AgentTracePanel } from '../chat/AgentTracePanel';
import { useAgentStore } from '../../stores/agentStore';
import '../../styles/chat/index.css';

export function WorkspaceView() {
  const state = useMarketStore((s) => s.state);
  const activeTab = useUiStore((s) => s.activeWorkspace);
  const activeTarget = useChatStore((s) => s.activeTarget);
  const agentProfileOpen = useChatStore((s) => s.agentProfileOpen);
  const selectedAgentId = useAgentStore((s) => s.selectedAgentId);

  const jin10Available = Boolean(state?.jin10?.status?.available && state?.config?.jin10?.enabled);

  const showTopbar = activeTab !== 'agent';

  return (
    <main className={`workspace-page${activeTab === 'agent' ? ' workspace-page--chat' : ''}`}>
      {showTopbar ? (
        <header className="topbar">
          <div className="topbar-left">
            <span className="workspace-title-icon" aria-hidden="true">
              {activeTab === 'market' ? <LineChart size={17} />
                : activeTab === 'news' ? <Newspaper size={17} />
                : activeTab === 'calendar' ? <CalendarDays size={17} />
                : activeTab === 'cron' ? <Clock size={17} />
                : activeTab === 'macro' ? <Globe size={17} />
                : <WalletCards size={17} />}
            </span>
            <div>
              <h1>{activeTab === 'market' ? 'Market' : activeTab.charAt(0).toUpperCase() + activeTab.slice(1)}</h1>
              <p className="workspace-subtitle">
                {activeTab === 'market' ? 'Watchlist and live market overview' : 'Tradex workspace'}
              </p>
            </div>
          </div>
        </header>
      ) : null}

      <section className="workspace">
        <section className={`main-content${activeTab === 'agent' ? ' main-content--chat' : ''}`}>
          {activeTab === 'market' && (
            <div className="market-workspace">
              <WatchlistSidebar mode="workspace" />
            </div>
          )}
          {activeTab === 'agent' && (
            <div className="agent-tab-layout">
              <AgentDirectMessageList />
              {activeTarget?.kind === 'channel' ? (
                <ChannelPanel />
              ) : activeTarget?.kind === 'origin' ? (
                <div className="agent-chat-main"><OriginSessionPanel /></div>
              ) : (
                <div className={`agent-chat-main${agentProfileOpen ? ' with-trace' : ''}`}>
                  <AgentSessionPanel
                    providerProfiles={state?.config.agent.providerProfiles ?? {}}
                    disabled={!state}
                  />
                  {agentProfileOpen && selectedAgentId ? <AgentTracePanel agentId={selectedAgentId} /> : null}
                </div>
              )}
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
          {activeTab === 'macro' && <MacroPanel />}
          {activeTab === 'cron' && <CronPanel />}
        </section>
      </section>
    </main>
  );
}
