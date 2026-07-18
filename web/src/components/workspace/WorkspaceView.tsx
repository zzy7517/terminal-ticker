import { useEffect } from 'react';
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
import { AgentDirectMessageList } from './AgentDirectMessageList';
import { AgentChatBar } from './AgentChatBar';
import { AgentSessionPanel } from './AgentSessionPanel';
import { NewsPanel } from './NewsPanel';
import { PositionsPanel } from './PositionsPanel';
import { CronPanel } from './CronPanel';
import { CalendarPanel } from './CalendarPanel';
import { OptionsPanel } from './OptionsPanel';
import { useAgentStore } from '../../stores/agentStore';
import { useChatStore } from '../../stores/chatStore';
import { ChannelPanel } from '../chat/ChannelPanel';
import { ChatReferencePanel } from '../chat/ChatReferencePanel';
import './AgentChatLayout.css';

export function WorkspaceView() {
  const state = useMarketStore((s) => s.state);
  const activeTab = useUiStore((s) => s.activeWorkspace);
  const createNewChat = useAgentStore((s) => s.createNewChat);
  const activeTarget = useChatStore((s) => s.activeTarget);
  const activeCollection = useChatStore((s) => s.activeCollection);
  const selectedAgentId = useAgentStore((s) => s.selectedAgentId);
  const activeAgentChatId = useAgentStore((s) => s.activeAgentChatId);
  const selectDirectChat = useChatStore((s) => s.selectDirectChat);
  const selectedChatStatus = useAgentStore((s) => (
    s.agentChatsByAgentId[s.selectedAgentId]?.find((chat) => chat.id === s.activeAgentChatId)?.status ?? 'active'
  ));

  const jin10Available = Boolean(state?.jin10?.status?.available && state?.config?.jin10?.enabled);
  useEffect(() => {
    if (!activeTarget && activeAgentChatId) selectDirectChat(selectedAgentId, activeAgentChatId);
  }, [activeAgentChatId, activeTarget, selectDirectChat, selectedAgentId]);

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
            <h1>{activeTab === 'agent' ? 'Chat' : activeTab === 'market' ? 'Market' : activeTab.charAt(0).toUpperCase() + activeTab.slice(1)}</h1>
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
              <AgentDirectMessageList />
              {activeCollection ? (
                <ChatReferencePanel />
              ) : activeTarget?.kind === 'channel' ? (
                <ChannelPanel />
              ) : (
                <div className="agent-chat-main">
                  <AgentChatBar />
                  <AgentSessionPanel
                    providerProfiles={state?.config.agent.providerProfiles ?? {}}
                    disabled={!state || selectedChatStatus === 'archived'}
                    onNewChat={() => void createNewChat(selectedAgentId)}
                  />
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
          {activeTab === 'cron' && <CronPanel />}
        </section>
      </section>
    </main>
  );
}
