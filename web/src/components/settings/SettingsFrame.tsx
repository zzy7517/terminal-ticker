import type { ReactNode } from 'react';
import {
  ArrowLeft,
  Bot,
  CircleDot,
  KeyRound,
  Newspaper,
  Settings,
} from 'lucide-react';
import type { SettingsSection } from '../../constants';
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

  const onSection = (next: SettingsSection) => {
    useUiStore.getState().openSettings(next);
  };
  const onBack = () => {
    useUiStore.getState().openWorkspace();
  };

  return (
    <main className="app-shell settings-shell-page">
      <section className="settings-frame">
        <aside className="settings-nav">
          <div className="settings-nav-top">
            <div>
              <div className="eyebrow">System Settings</div>
              <h3>Settings</h3>
            </div>
          </div>

          <div className="settings-nav-group">
            <button
              className={`settings-nav-item ${section === 'providers' ? 'active' : ''}`}
              type="button"
              onClick={() => onSection('providers')}
            >
              <Settings size={18} />
              <span>Providers</span>
            </button>
            <button
              className={`settings-nav-item ${section === 'agent-context' ? 'active' : ''}`}
              type="button"
              onClick={() => onSection('agent-context')}
            >
              <Bot size={18} />
              <span>Agent Context</span>
            </button>
            <button
              className={`settings-nav-item ${section === 'watchlist' ? 'active' : ''}`}
              type="button"
              onClick={() => onSection('watchlist')}
            >
              <CircleDot size={18} />
              <span>Watchlist</span>
            </button>
            <button
              className={`settings-nav-item ${section === 'news' ? 'active' : ''}`}
              type="button"
              onClick={() => onSection('news')}
            >
              <Newspaper size={18} />
              <span>News</span>
            </button>
            <button
              className={`settings-nav-item ${section === 'social' ? 'active' : ''}`}
              type="button"
              onClick={() => onSection('social')}
            >
              <KeyRound size={18} />
              <span>Social</span>
            </button>
          </div>

          <div className="settings-nav-meta">
            <span className="panel-label">Source</span>
            <strong>{state?.config.sourcePath ?? 'Runtime only'}</strong>
          </div>

          <button className="settings-back" type="button" onClick={onBack}>
            <ArrowLeft size={16} />
            Back to workspace
          </button>
        </aside>

        <section className="settings-stage">{children}</section>
      </section>
    </main>
  );
}
