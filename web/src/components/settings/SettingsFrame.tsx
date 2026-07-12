import { useMemo, useState, type ReactNode } from 'react';
import {
  Activity,
  ArrowLeft,
  Bot,
  Brain,
  Cable,
  Chrome,
  CircleDot,
  Clock,
  KeyRound,
  Network,
  Newspaper,
  Search,
  Settings,
} from 'lucide-react';
import type { SettingsSection } from '../../constants';
import './SettingsFrame.css';
import { useMarketStore } from '../../stores/marketStore';
import { useUiStore } from '../../stores/uiStore';

export function SettingsFrame({
  children,
}: {
  children: ReactNode;
}) {
  const state = useMarketStore((s) => s.state);
  const route = useUiStore((s) => s.route);
  const section: SettingsSection = route.view === 'settings' ? route.section : 'providers';
  const [query, setQuery] = useState('');

  const groups = useMemo(() => [
    {
      label: 'Agent',
      items: [
        { id: 'agents' as const, label: 'Agents', icon: Bot },
        { id: 'providers' as const, label: 'Runtimes', icon: Settings },
        { id: 'agent-context' as const, label: 'Agent Context', icon: Bot },
        { id: 'memory' as const, label: 'Memory', icon: Brain },
      ],
    },
    {
      label: 'Market Data',
      items: [
        { id: 'watchlist' as const, label: 'Watchlist', icon: CircleDot },
        { id: 'news' as const, label: 'News', icon: Newspaper },
        { id: 'social' as const, label: 'Social', icon: KeyRound },
        { id: 'options' as const, label: 'Options', icon: Activity },
      ],
    },
    {
      label: 'Automation',
      items: [{ id: 'cron' as const, label: 'Cron', icon: Clock }],
    },
    {
      label: 'Integrations',
      items: [
        { id: 'mcp' as const, label: 'MCP', icon: Cable },
        { id: 'browser' as const, label: 'Browser', icon: Chrome },
        { id: 'proxy' as const, label: 'Proxy', icon: Network },
      ],
    },
  ], []);

  const normalizedQuery = query.trim().toLowerCase();
  const visibleGroups = groups
    .map((group) => ({
      ...group,
      items: group.items.filter((item) => item.label.toLowerCase().includes(normalizedQuery)),
    }))
    .filter((group) => group.items.length > 0);

  const onSection = (next: SettingsSection) => {
    useUiStore.getState().openSettings(next);
  };
  const onBack = () => useUiStore.getState().openWorkspace();

  const wide = section === 'providers' || section === 'mcp' || section === 'watchlist';

  return (
    <main className="settings-page">
      <section className="settings-frame">
        <aside className="settings-nav">
          <div className="settings-nav-top">
            <button
              aria-label="Back to Tradex"
              className="settings-return"
              type="button"
              onClick={onBack}
            >
              <ArrowLeft size={15} />
              <span>Back to Tradex</span>
            </button>
            <label className="settings-search">
              <Search size={15} aria-hidden="true" />
              <input
                aria-label="Search settings"
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search settings"
                type="search"
                value={query}
              />
            </label>
          </div>

          <nav className="settings-nav-groups" aria-label="Settings navigation">
            {visibleGroups.map((group) => (
              <section className="settings-nav-section" key={group.label}>
                <div className="settings-nav-label">{group.label}</div>
                <div className="settings-nav-group">
                  {group.items.map((item) => {
                    const Icon = item.icon;
                    return (
                      <button
                        className={`settings-nav-item ${section === item.id ? 'active' : ''}`}
                        key={item.id}
                        type="button"
                        onClick={() => onSection(item.id)}
                      >
                        <Icon size={17} />
                        <span>{item.label}</span>
                      </button>
                    );
                  })}
                </div>
              </section>
            ))}
            {visibleGroups.length === 0 ? (
              <p className="settings-search-empty">No matching settings</p>
            ) : null}
          </nav>

          <div className="settings-nav-meta">
            <span>Configuration source</span>
            <strong>{state?.config.sourcePath ?? 'Runtime only'}</strong>
          </div>
        </aside>

        <section className={`settings-stage ${wide ? 'settings-stage-wide' : ''}`}>
          <div className="settings-stage-inner">{children}</div>
        </section>
      </section>
    </main>
  );
}
