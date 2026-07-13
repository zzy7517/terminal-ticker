import {
  Activity,
  Bot,
  CalendarDays,
  Clock,
  LineChart,
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
  icon: typeof Bot;
  available?: boolean;
};

export function AppSidebar() {
  const route = useUiStore((s) => s.route);
  const activeWorkspace = useUiStore((s) => s.activeWorkspace);
  const state = useMarketStore((s) => s.state);

  const jin10Available = Boolean(state?.jin10?.status?.available && state?.config?.jin10?.enabled);
  const optionsState = (state as any)?.options?.snapshots;
  const optionsAvailable = Boolean(optionsState && Object.keys(optionsState).length > 0);
  const items: NavItem[] = [
    { id: 'agent', label: 'Agent', icon: Bot },
    { id: 'market', label: 'Market', icon: LineChart },
    { id: 'news', label: 'News', icon: Newspaper },
    { id: 'calendar', label: 'Calendar', icon: CalendarDays, available: jin10Available },
    { id: 'positions', label: 'Positions', icon: WalletCards },
    { id: 'options', label: 'Options', icon: Activity, available: optionsAvailable },
    { id: 'cron', label: 'Cron', icon: Clock },
  ];

  const openWorkspace = (view: WorkspaceViewId) => {
    useUiStore.getState().setActiveWorkspace(view);
    useUiStore.getState().openWorkspace();
  };

  return (
    <aside className="app-sidebar">
      <div className="app-sidebar-brand">
        <span>Tradex</span>
      </div>

      <nav className="app-sidebar-nav" aria-label="Workspace navigation">
        {items.filter((item) => item.available !== false).map((item) => {
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
        })}
      </nav>

      <div className="app-sidebar-footer">
        <div className="app-sidebar-utility-row">
          <div className="app-sidebar-status">
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
