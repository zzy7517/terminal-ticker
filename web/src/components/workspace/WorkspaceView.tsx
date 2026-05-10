import { useState } from 'react';
import {
  ChevronsLeft,
  ChevronsRight,
  Moon,
  Settings,
  Sun,
  Zap,
} from 'lucide-react';
import { useMarketStore, useGroups, useSelectedInstrument, useSelectedQuote } from '../../stores/marketStore';
import { useUiStore } from '../../stores/uiStore';
import { GROUP_LABELS, THEME_LABELS } from '../../constants';
import type { ThemeName } from '../../constants';
import { changeClass, nextTheme, sourceName } from '../../utils';
import { ConnectionBadge } from './ConnectionBadge';
import { WatchlistRow } from './WatchlistRow';
import { StatTile } from './StatTile';
import { AgentSessionHistoryList } from './AgentSessionHistoryList';
import { AgentSessionPanel } from './AgentSessionPanel';
import { NewsPanel } from './NewsPanel';
import { SocialFeedPanel } from './SocialFeedPanel';
import { PositionsPanel } from './PositionsPanel';

export function WorkspaceView() {
  const state = useMarketStore((s) => s.state);
  const socketStatus = useMarketStore((s) => s.socketStatus);

  const theme = useUiStore((s) => s.theme);
  const sidebarCollapsed = useUiStore((s) => s.sidebarCollapsed);
  const setSidebarCollapsed = useUiStore((s) => s.setSidebarCollapsed);
  const selectedKey = useUiStore((s) => s.selectedKey);
  const setSelectedKey = useUiStore((s) => s.setSelectedKey);
  const activeGroup = useUiStore((s) => s.activeGroup);
  const setActiveGroup = useUiStore((s) => s.setActiveGroup);
  const openSettings = useUiStore((s) => s.openSettings);

  const groups = useGroups();
  const selectedInstrument = useSelectedInstrument();
  const selectedQuote = useSelectedQuote();

  const currentInterval = selectedInstrument?.analysisInterval ?? state?.config.analysis.interval ?? '5m';
  const nextThemeName: ThemeName = nextTheme(theme);

  const activeKeys = activeGroup && state ? state.groups[activeGroup] ?? [] : [];
  const collapsedKeys = state?.instruments.map((instrument) => instrument.key) ?? [];

  const [activeTab, setActiveTab] = useState<'agent' | 'news' | 'social' | 'positions'>('agent');
  const selectedSourceLabel = selectedInstrument ? sourceName(selectedInstrument.source) : '-';
  const selectedGroupLabel = selectedInstrument ? GROUP_LABELS[selectedInstrument.group] ?? selectedInstrument.group : '-';
  const selectedPrice = selectedQuote?.priceLabel ?? '-';
  const selectedChange = selectedQuote
    ? `${selectedQuote.changeLabel ?? '-'} · ${selectedQuote.percentLabel ?? '-'}`
    : '-';

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="topbar-left">
          <button
            aria-label={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            className="sidebar-toggle-button"
            onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
            title={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            type="button"
          >
            {sidebarCollapsed ? <ChevronsRight size={18} /> : <ChevronsLeft size={18} />}
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
        {(['agent', 'news', 'social', 'positions'] as const).map((tab) => (
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

      <section className={`workspace ${sidebarCollapsed ? 'sidebar-collapsed' : ''}`}>
        <aside className={`sidebar ${sidebarCollapsed ? 'collapsed' : ''}`}>
          {!sidebarCollapsed && (
            <>
              <div className="sidebar-head">
                <span className="sidebar-title">自选列表</span>
                <button
                  aria-label="Manage watchlist"
                  className="sidebar-manage-button"
                  onClick={() => useUiStore.getState().openSettings('watchlist')}
                  type="button"
                >
                  <Settings size={14} />
                </button>
              </div>
              <div className="group-tabs">
                {groups.map((group) => (
                  <button
                    className={group === activeGroup ? 'active' : ''}
                    key={group}
                    type="button"
                    onClick={() => setActiveGroup(group)}
                  >
                    {GROUP_LABELS[group] ?? group}
                  </button>
                ))}
              </div>
              <div className="watchlist-header">
                <span>名称/代码</span>
                <span>最新价</span>
                <span>涨跌幅</span>
              </div>
              <div className="watchlist">
                {state &&
                  activeKeys.map((key) => {
                    const instrument = state.instruments.find((item) => item.key === key);
                    if (!instrument) return null;
                    return (
                      <WatchlistRow
                        key={key}
                        instrument={instrument}
                        quote={state.quotes[key]}
                        selected={selectedKey === key}
                        onSelect={() => setSelectedKey(key)}
                      />
                    );
                  })}
              </div>
            </>
          )}
          {sidebarCollapsed && (
            <div className="sidebar-collapsed-content">
              <div className="sidebar-collapsed-icons">
                <button
                  aria-label="Manage watchlist"
                  className="sidebar-manage-button"
                  onClick={() => useUiStore.getState().openSettings('watchlist')}
                  type="button"
                  title="Manage watchlist"
                >
                  <Settings size={16} />
                </button>
              </div>
              <div className="sidebar-collapsed-symbols">
                {state &&
                  collapsedKeys.map((key) => {
                    const instrument = state.instruments.find((item) => item.key === key);
                    if (!instrument) return null;
                    return (
                      <button
                        key={key}
                        className={`sidebar-collapsed-symbol ${selectedKey === key ? 'selected' : ''}`}
                        onClick={() => setSelectedKey(key)}
                        type="button"
                        title={`${instrument.label} (${instrument.symbol})`}
                      >
                        <span className="collapsed-symbol-label">{instrument.label}</span>
                        <span className={`collapsed-symbol-price ${changeClass(state.quotes[key])}`}>
                          {state.quotes[key]?.percentLabel ?? '-'}
                        </span>
                      </button>
                    );
                  })}
              </div>
            </div>
          )}
        </aside>

        <section className="main-content">
          <section className="market-summary">
            <div className="market-summary-head">
              <div>
                <div className="eyebrow">Focus Symbol</div>
                <h2>{selectedInstrument?.label ?? '选择标的'}</h2>
                <p className="market-summary-meta">
                  {selectedInstrument?.symbol ?? '-'} · {selectedSourceLabel} · {selectedGroupLabel}
                </p>
              </div>
              <div className="price-readout">
                <span className="readout-label">Last</span>
                <strong>{selectedPrice}</strong>
                <span className={changeClass(selectedQuote)}>
                  {selectedChange}
                </span>
              </div>
            </div>

            <div className="stat-grid">
              <StatTile label="Source" value={selectedSourceLabel} />
              <StatTile label="Interval" value={currentInterval} />
              <StatTile label="High" value={selectedQuote?.dayHigh?.toFixed(2) ?? '-'} />
              <StatTile label="Low" value={selectedQuote?.dayLow?.toFixed(2) ?? '-'} />
              <StatTile label="Volume" value={selectedQuote?.volumeLabel ?? '-'} />
              <StatTile label="Age" value={selectedQuote?.ageLabel ?? 'waiting'} />
            </div>
          </section>

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
        </section>
      </section>
    </main>
  );
}
