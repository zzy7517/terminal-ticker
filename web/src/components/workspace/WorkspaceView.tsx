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

/**每个工作区的标题与副标题。副标题写这个页面实际显示什么，而不是泛泛的一句场景词。 */
const WORKSPACE_COPY: Record<string, { title: string; subtitle: string }> = {
  market: { title: 'Market', subtitle: '自选列表与实时行情总览' },
  news: { title: 'News', subtitle: '按时间排序的市场快讯与来源状态' },
  calendar: { title: 'Calendar', subtitle: '金十财经日历，含前值、预期与实际值' },
  positions: { title: 'Positions', subtitle: '交易所持仓、活跃订单与交易复盘' },
  options: { title: 'Options', subtitle: 'GEX 分布、关键价位与异动期权流' },
  macro: { title: 'Macro', subtitle: '利率、通胀、美元与波动率的横截面' },
  cron: { title: 'Cron', subtitle: '定时任务的排期与最近执行结果' },
};

export function WorkspaceView() {
  const state = useMarketStore((s) => s.state);
  const activeTab = useUiStore((s) => s.activeWorkspace);
  const activeTarget = useChatStore((s) => s.activeTarget);
  const agentProfileOpen = useChatStore((s) => s.agentProfileOpen);
  const selectedAgentId = useAgentStore((s) => s.selectedAgentId);

  const jin10Available = Boolean(state?.jin10?.status?.available && state?.config?.jin10?.enabled);

  const showTopbar = activeTab !== 'agent';
  const copy = WORKSPACE_COPY[activeTab] ?? {
    title: activeTab.charAt(0).toUpperCase() + activeTab.slice(1),
    subtitle: '',
  };

  return (
    <main className={`workspace-page${activeTab === 'agent' ? ' workspace-page--chat' : ''}`}>
      {showTopbar ? (
        <header className="topbar">
          <div className="topbar-left">
            <h1>{copy.title}</h1>
            {copy.subtitle ? <p className="workspace-subtitle">{copy.subtitle}</p> : null}
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
