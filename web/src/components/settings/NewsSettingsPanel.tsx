import { useEffect, useState } from 'react';
import { Newspaper, Plus } from 'lucide-react';
import './NewsSettingsPanel.css';
import type { NewsConfigUpdate } from '../../types';
import { useMarketStore } from '../../stores/marketStore';
import { saveNewsConfig } from '../../api';

export function NewsSettingsPanel() {
  const state = useMarketStore((s) => s.state);
  const config = state?.config.news;
  const configSignature = config ? JSON.stringify(config) : '';
  const [draft, setDraft] = useState<NewsConfigUpdate | null>(null);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState('Toggle news ingestion on to start polling Reuters.');

  useEffect(() => {
    if (!config) return;
    setDraft({ enabled: config.enabled });
  }, [configSignature]);

  async function persistConfig(nextEnabled: boolean) {
    setSaving(true);
    setStatus(nextEnabled ? 'Starting news service...' : 'Stopping news service...');
    try {
      const nextState = await saveNewsConfig({ enabled: nextEnabled });
      useMarketStore.getState().setState(nextState);
      setDraft({ enabled: nextEnabled });
      setStatus(nextEnabled ? 'News ingestion enabled.' : 'News ingestion disabled.');
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Save failed.');
      if (config) setDraft({ enabled: config.enabled });
    } finally {
      setSaving(false);
    }
  }

  if (!config || !draft) {
    return <div className="empty-state lg">Loading settings...</div>;
  }

  const newsStatus = state?.newsStatus;
  const lastFetched = newsStatus?.lastFetchedAtMs
    ? new Date(newsStatus.lastFetchedAtMs).toLocaleString()
    : '—';

  return (
    <>
      <header className="settings-stage-head">
        <div>
          <div className="eyebrow">Configuration</div>
          <h2>News</h2>
        </div>
        <div className="settings-stage-actions">
          <span className={`badge${config.enabled ? ' success' : ''}`}>{config.enabled ? 'Active' : 'Disabled'}</span>
        </div>
      </header>

      <div className="provider-layout">
        <section className="provider-catalog">
          <div className="provider-section-head">
            <strong>Sources</strong>
            <span className="badge">1 active</span>
          </div>
          <div className="provider-list">
            <button className="provider-item selected" type="button" disabled>
              <div className="provider-item-icon">
                <Newspaper size={18} />
              </div>
              <div className="provider-item-body">
                <strong>Reuters</strong>
                <small>Sitemap poller — news.reuters.com</small>
              </div>
              <span className={`badge${config.enabled ? ' success' : ''}`}>
                {config.enabled ? 'On' : 'Off'}
              </span>
            </button>
            <div className="provider-item" aria-disabled>
              <div className="provider-item-icon">
                <Plus size={16} />
              </div>
              <div className="provider-item-body">
                <strong>Add source</strong>
                <small>More providers coming soon.</small>
              </div>
            </div>
          </div>
        </section>

        <section className="provider-detail">
          <div className="provider-section-head">
            <strong>Module</strong>
          </div>

          <label className="settings-toggle-row">
            <div>
              <strong>Enable news ingestion</strong>
              <small>
                Controls the [news] block in watchlist.toml and start/stops the background poller.
              </small>
            </div>
            <button
              className={`settings-toggle ${draft.enabled ? 'on' : ''}`}
              type="button"
              disabled={saving}
              onClick={() => persistConfig(!draft.enabled)}
              aria-pressed={!!draft.enabled}
            >
              <span />
            </button>
          </label>

          <div className="settings-readonly-grid">
            <div>
              <span className="panel-label">Source URL</span>
              <strong>{config.reutersUrl}</strong>
            </div>
            <div>
              <span className="panel-label">Poll interval</span>
              <strong>{config.pollIntervalSeconds}s (max {config.maxIntervalSeconds}s)</strong>
            </div>
            <div>
              <span className="panel-label">Request timeout</span>
              <strong>{config.requestTimeoutSeconds}s</strong>
            </div>
            <div>
              <span className="panel-label">Retention</span>
              <strong>{config.retentionDays} days</strong>
            </div>
            <div>
              <span className="panel-label">Recent limit</span>
              <strong>{config.recentLimit}</strong>
            </div>
            <div>
              <span className="panel-label">Last fetch status</span>
              <strong>{newsStatus?.lastStatus ?? 'idle'}</strong>
            </div>
            <div>
              <span className="panel-label">Last fetched at</span>
              <strong>{lastFetched}</strong>
            </div>
            {newsStatus?.lastError && (
              <div>
                <span className="panel-label">Last error</span>
                <strong>{newsStatus.lastError}</strong>
              </div>
            )}
          </div>
          <div className="settings-hint">
            Tip: polling/retention/url are read-only here. Edit watchlist.toml and restart the
            backend to change them.
          </div>

          <div className="provider-status-bar">{status}</div>
        </section>
      </div>
    </>
  );
}
