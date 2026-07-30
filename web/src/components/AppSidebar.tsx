import { useMemo } from 'react';
import {
  Activity,
  CalendarDays,
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

export function AppSidebar() {
  const route = useUiStore((s) => s.route);
  const activeWorkspace = useUiStore((s) => s.activeWorkspace);
  const state = useMarketStore((s) => s.state);

  const jin10Available = Boolean(state?.jin10?.status?.available && state?.config?.jin10?.enabled);
  const optionsSnapshots = state?.options?.snapshots;
  const optionsAvailable = Boolean(optionsSnapshots && Object.keys(optionsSnapshots).length > 0);
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

  const openWorkspace = (view: WorkspaceViewId) => {
    useUiStore.getState().setActiveWorkspace(view);
    useUiStore.getState().openWorkspace();
  };

  const renderItem = (item: NavItem) => {
    const Icon = item.icon;
    const active = route.view === 'workspace' && activeWorkspace === item.id;
    return (
      <button
        className={'app-sidebar-item' + (active ? ' active' : '')}
        key={item.id}
        onClick={() => openWorkspace(item.id)}
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
        <div className="app-sidebar-group">{available.map((item) => renderItem(item))}</div>
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
