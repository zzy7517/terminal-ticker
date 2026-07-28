import { useMemo, useState } from 'react';
import {
  Activity,
  CalendarDays,
  ChevronDown,
  Clock,
  Globe,
  LineChart,
  MessageSquare,
  Newspaper,
  Radio,
  Settings,
  WalletCards,
} from 'lucide-react';
import { useMarketStore } from '../stores/marketStore';
import { useUiStore, type WorkspaceViewId } from '../stores/uiStore';
import { ThemeToggle } from './ThemeToggle';
import './AppSidebar.css';

type NavItem = {
  id: WorkspaceViewId;
  label: string;
  icon: typeof MessageSquare;
  available?: boolean;
};

const PRIMARY_IDS: WorkspaceViewId[] = ['agent', 'market', 'positions'];

export function AppSidebar() {
  const route = useUiStore((s) => s.route);
  const activeWorkspace = useUiStore((s) => s.activeWorkspace);
  const state = useMarketStore((s) => s.state);
  const [moreOpen, setMoreOpen] = useState(false);

  const jin10Available = Boolean(state?.jin10?.status?.available && state?.config?.jin10?.enabled);
  const optionsState = (state as any)?.options?.snapshots;
  const optionsAvailable = Boolean(optionsState && Object.keys(optionsState).length > 0);
  const macroAvailable = Boolean((state as any)?.config?.macro?.enabled);

  const items: NavItem[] = useMemo(
    () => [
      { id: 'agent', label: 'Chat', icon: MessageSquare },
      { id: 'market', label: 'Market', icon: LineChart },
      { id: 'positions', label: 'Positions', icon: WalletCards },
      { id: 'news', label: 'News', icon: Newspaper },
      { id: 'calendar', label: 'Calendar', icon: CalendarDays, available: jin10Available },
      { id: 'options', label: 'Options', icon: Activity, available: optionsAvailable },
      { id: 'macro', label: 'Macro', icon: Globe, available: macroAvailable },
      { id: 'cron', label: 'Cron', icon: Clock },
    ],
    [jin10Available, optionsAvailable, macroAvailable],
  );

  const available = items.filter((item) => item.available !== false);
  const primary = available.filter((item) => PRIMARY_IDS.includes(item.id));
  const more = available.filter((item) => !PRIMARY_IDS.includes(item.id));
  const moreActive = more.some((item) => route.view === 'workspace' && activeWorkspace === item.id);
  const showMore = moreOpen || moreActive;

  const openWorkspace = (view: WorkspaceViewId) => {
    useUiStore.getState().setActiveWorkspace(view);
    useUiStore.getState().openWorkspace();
  };

  const renderItem = (item: NavItem, index: number) => {
    const Icon = item.icon;
    const active = route.view === 'workspace' && activeWorkspace === item.id;
    return (
      <button
        className={'app-sidebar-item' + (active ? ' active' : '')}
        key={item.id}
        onClick={() => openWorkspace(item.id)}
        style={{ '--nav-index': index } as React.CSSProperties}
        type="button"
      >
        <Icon size={17} />
        <span>{item.label}</span>
      </button>
    );
  };

  return (
    <aside className="app-sidebar">
      <div className="app-sidebar-brand">
        <span className="app-sidebar-brand-mark" aria-hidden="true">tx</span>
        <span className="app-sidebar-brand-name">Tradex</span>
      </div>

      <nav className="app-sidebar-nav" aria-label="Workspace navigation">
        <div className="app-sidebar-group">{primary.map((item, index) => renderItem(item, index))}</div>

        {more.length > 0 ? (
          <div className="app-sidebar-more">
            <button
              aria-expanded={showMore}
              className={'app-sidebar-more-toggle' + (moreActive ? ' has-active' : '')}
              onClick={() => setMoreOpen((open) => !open)}
              type="button"
            >
              <span>更多</span>
              <ChevronDown
                className={'app-sidebar-more-chevron' + (showMore ? ' open' : '')}
                size={14}
              />
            </button>
            {showMore ? (
              <div className="app-sidebar-group app-sidebar-group--more">
                {more.map((item, index) => renderItem(item, primary.length + index))}
              </div>
            ) : null}
          </div>
        ) : null}
      </nav>

      <div className="app-sidebar-footer">
        <div className="app-sidebar-utility-row">
          <div className={'app-sidebar-status' + (state ? '' : ' connecting')}>
            <Radio size={14} />
            <span>{state ? 'Runtime connected' : 'Connecting'}</span>
          </div>
          <ThemeToggle />
        </div>
        <button
          className={'app-sidebar-item' + (route.view === 'settings' ? ' active' : '')}
          onClick={() => useUiStore.getState().openSettings()}
          type="button"
        >
          <Settings size={17} />
          <span>Settings</span>
        </button>
      </div>
    </aside>
  );
}
