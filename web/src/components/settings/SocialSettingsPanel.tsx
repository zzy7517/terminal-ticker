import { useEffect, useState } from 'react';
import { EyeOff, Loader2, LockKeyhole, RefreshCw, Save, Search, Trash2 } from 'lucide-react';
import './SocialSettingsPanel.css';
import type { SocialAuthStatus, SocialFeedItem } from '../../types';
import { useMarketStore } from '../../stores/marketStore';
import {
  clearSocialAuth,
  fetchRecentSocialFeed,
  fetchSocialAuthStatus,
  saveSocialAuth,
  saveSocialFeedConfig,
  triggerXFollowingRefresh,
} from '../../api';

export function SocialSettingsPanel() {
  const state = useMarketStore((s) => s.state);
  const config = state?.config.socialFeed;
  const configSignature = config ? JSON.stringify(config) : '';
  const [authStatus, setAuthStatus] = useState<SocialAuthStatus | null>(null);
  const [authToken, setAuthToken] = useState('');
  const [ct0, setCt0] = useState('');
  const [savingAuth, setSavingAuth] = useState(false);
  const [savingConfig, setSavingConfig] = useState(false);
  const [testing, setTesting] = useState(false);
  const [feedPreview, setFeedPreview] = useState<SocialFeedItem[]>([]);
  const [recentLimitInput, setRecentLimitInput] = useState('');
  const [retentionDaysInput, setRetentionDaysInput] = useState('');
  const [maxItemsInput, setMaxItemsInput] = useState('');
  const [refreshCountInput, setRefreshCountInput] = useState('20');
  const [status, setStatus] = useState('Save X cookies locally, then enable the social feed reader.');

  useEffect(() => {
    let cancelled = false;
    fetchSocialAuthStatus()
      .then((nextStatus) => {
        if (!cancelled) setAuthStatus(nextStatus);
      })
      .catch((error) => {
        if (!cancelled) {
          setStatus(error instanceof Error ? error.message : 'Could not load social auth status.');
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!config) return;
    setRecentLimitInput(String(config.recentLimit));
    setRetentionDaysInput(String(config.retentionDays));
    setMaxItemsInput(String(config.maxItems));
    setStatus(config.enabled ? 'Social feed reader is enabled.' : 'Social feed reader is disabled.');
  }, [configSignature]);

  async function persistSocialEnabled(nextEnabled: boolean) {
    if (!config) return;
    setSavingConfig(true);
    setStatus(nextEnabled ? 'Enabling social feed reader...' : 'Disabling social feed reader...');
    try {
      const nextState = await saveSocialFeedConfig({ enabled: nextEnabled });
      useMarketStore.getState().setState(nextState);
      setStatus(nextEnabled ? 'Social feed reader enabled.' : 'Social feed reader disabled.');
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Save failed.');
    } finally {
      setSavingConfig(false);
    }
  }

  async function persistCacheSettings() {
    if (!config) return;
    const recentLimit = Number.parseInt(recentLimitInput, 10);
    const retentionDays = Number.parseInt(retentionDaysInput, 10);
    const maxItems = Number.parseInt(maxItemsInput, 10);
    if (!Number.isFinite(recentLimit) || recentLimit < 1 || recentLimit > 200) {
      setStatus('Recent limit must be between 1 and 200.');
      return;
    }
    if (!Number.isFinite(retentionDays) || retentionDays < 1 || retentionDays > 365) {
      setStatus('Retention must be between 1 and 365 days.');
      return;
    }
    if (!Number.isFinite(maxItems) || maxItems < 100) {
      setStatus('Max cached items must be at least 100.');
      return;
    }
    setSavingConfig(true);
    setStatus('Saving social cache settings...');
    try {
      const nextState = await saveSocialFeedConfig({ recentLimit, retentionDays, maxItems });
      useMarketStore.getState().setState(nextState);
      setStatus('Social cache settings saved.');
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Save failed.');
    } finally {
      setSavingConfig(false);
    }
  }

  async function persistAuth() {
    setSavingAuth(true);
    setStatus('Saving X auth locally...');
    try {
      const nextStatus = await saveSocialAuth({ authToken, ct0 });
      setAuthStatus(nextStatus);
      setAuthToken('');
      setCt0('');
      setStatus('X auth saved. Values are not shown again after saving.');
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Auth save failed.');
    } finally {
      setSavingAuth(false);
    }
  }

  async function clearAuth() {
    setSavingAuth(true);
    setStatus('Clearing saved X auth...');
    try {
      const nextStatus = await clearSocialAuth();
      setAuthStatus(nextStatus);
      setStatus('Saved X auth cleared.');
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Clear failed.');
    } finally {
      setSavingAuth(false);
    }
  }

  async function testRefresh() {
    const refreshCount = Number.parseInt(refreshCountInput, 10);
    if (!Number.isFinite(refreshCount) || refreshCount < 1 || refreshCount > 100) {
      setStatus('Refresh count must be between 1 and 100.');
      return;
    }
    setTesting(true);
    setStatus(`Testing X Following refresh with ${refreshCount} item(s)...`);
    try {
      const result = await triggerXFollowingRefresh(refreshCount);
      const items = await fetchRecentSocialFeed(Math.min(refreshCount, 20));
      setFeedPreview(items);
      setStatus(
        result.status === 'ok'
          ? `Refresh ok. New ${result.inserted}, cached ${result.totalRecent}, showing ${items.length}.`
          : `Refresh ${result.status}: ${result.error ?? 'unknown error'}`,
      );
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Refresh failed.');
    } finally {
      setTesting(false);
    }
  }

  async function loadCachedFeed() {
    const refreshCount = Number.parseInt(refreshCountInput, 10);
    if (!Number.isFinite(refreshCount) || refreshCount < 1 || refreshCount > 100) {
      setStatus('Refresh count must be between 1 and 100.');
      return;
    }
    setTesting(true);
    setStatus('Loading cached social feed sample...');
    try {
      const items = await fetchRecentSocialFeed(Math.min(refreshCount, 20));
      setFeedPreview(items);
      setStatus(items.length ? `Loaded ${items.length} cached item(s).` : 'No cached feed items yet.');
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Cached feed load failed.');
    } finally {
      setTesting(false);
    }
  }

  if (!config) {
    return <div className="empty-state lg">Loading settings...</div>;
  }

  const hasUsableAuth = Boolean(authStatus?.hasSavedAuth || authStatus?.envAvailable);
  const savedAt = authStatus?.savedAtMs ? new Date(authStatus.savedAtMs).toLocaleString() : '—';
  const canSaveAuth = authToken.trim().length > 0 && ct0.trim().length > 0 && !savingAuth;
  const parsedRecentLimit = Number.parseInt(recentLimitInput, 10);
  const parsedRetentionDays = Number.parseInt(retentionDaysInput, 10);
  const parsedMaxItems = Number.parseInt(maxItemsInput, 10);
  const cacheSettingsValid =
    Number.isFinite(parsedRecentLimit) &&
    parsedRecentLimit >= 1 &&
    parsedRecentLimit <= 200 &&
    Number.isFinite(parsedRetentionDays) &&
    parsedRetentionDays >= 1 &&
    parsedRetentionDays <= 365 &&
    Number.isFinite(parsedMaxItems) &&
    parsedMaxItems >= 100;
  const cacheSettingsChanged =
    parsedRecentLimit !== config.recentLimit ||
    parsedRetentionDays !== config.retentionDays ||
    parsedMaxItems !== config.maxItems;
  const parsedRefreshCount = Number.parseInt(refreshCountInput, 10);
  const refreshCountValid =
    Number.isFinite(parsedRefreshCount) && parsedRefreshCount >= 1 && parsedRefreshCount <= 100;

  return (
    <>
      <header className="settings-stage-head">
        <div>
          <div className="eyebrow">Local X Feed</div>
          <h2>Social</h2>
        </div>
        <div className="settings-stage-actions">
          <span className={`badge${config.enabled ? ' success' : ''}`}>
            {config.enabled ? 'Reader On' : 'Reader Off'}
          </span>
          <span className={`badge${hasUsableAuth ? ' success' : ''}`}>
            {hasUsableAuth ? 'Auth Ready' : 'Auth Missing'}
          </span>
        </div>
      </header>

      <div className="social-settings-layout">
        <section className="provider-detail social-vault-card">
          <div className="provider-section-head">
            <strong>X Auth Vault</strong>
            <span className="badge">local only</span>
          </div>
          <p className="settings-hint" style={{ marginTop: 0 }}>
            Paste the two x.com cookies here once. They are stored on this machine and never echoed back
            into the UI.
          </p>

          <div className="social-auth-state">
            <div className="social-auth-state__icon">
              <LockKeyhole size={20} />
            </div>
            <div>
              <strong>{authStatus?.hasSavedAuth ? 'Saved auth is available' : 'No saved auth yet'}</strong>
              <span>
                {authStatus?.hasSavedAuth
                  ? `Saved at ${savedAt}`
                  : authStatus?.envAvailable
                    ? 'Environment variables are available as fallback.'
                    : 'Paste auth_token and ct0 to enable X refresh.'}
              </span>
            </div>
          </div>

          <div className="social-auth-form">
            <label>
              <span className="panel-label">auth_token</span>
              <input
                className="input"
                value={authToken}
                onChange={(event) => setAuthToken(event.target.value)}
                placeholder="Paste auth_token value"
                type="password"
                autoComplete="off"
                spellCheck={false}
              />
            </label>
            <label>
              <span className="panel-label">ct0</span>
              <input
                className="input"
                value={ct0}
                onChange={(event) => setCt0(event.target.value)}
                placeholder="Paste ct0 value"
                type="password"
                autoComplete="off"
                spellCheck={false}
              />
            </label>
          </div>

          <div className="settings-action-row">
            <button className="shell-button primary" type="button" disabled={!canSaveAuth} onClick={persistAuth}>
              {savingAuth ? <Loader2 className="spin" size={15} /> : <Save size={15} />}
              Save auth
            </button>
            <button
              className="shell-button danger"
              type="button"
              disabled={savingAuth || !authStatus?.hasSavedAuth}
              onClick={clearAuth}
            >
              <Trash2 size={15} />
              Clear saved auth
            </button>
          </div>

          <div className="settings-hint social-secret-note">
            <EyeOff size={14} />
            Values are written to the backend local cache with file permissions tightened to owner-only.
          </div>

          <div className="social-test-panel">
            <div className="provider-section-head">
              <strong>Quick Tests</strong>
              <span className="badge">manual</span>
            </div>
            <label className="social-test-count">
              <span className="panel-label">Refresh count</span>
              <input
                className="input mono"
                value={refreshCountInput}
                onChange={(event) => setRefreshCountInput(event.target.value)}
                type="number"
                min={1}
                max={100}
                step={1}
              />
              <small>Controls the POST /api/social/x/refresh payload count. Preview shows up to 20 items.</small>
            </label>
            <div className="settings-action-row">
              <button
                className="shell-button"
                type="button"
                disabled={!config.enabled || !hasUsableAuth || testing || !refreshCountValid}
                onClick={testRefresh}
              >
                {testing ? <Loader2 className="spin" size={15} /> : <RefreshCw size={15} />}
                Refresh + cache
              </button>
              <button
                className="shell-button"
                type="button"
                disabled={!config.enabled || testing || !refreshCountValid}
                onClick={loadCachedFeed}
              >
                <Search size={15} />
                Read cache
              </button>
            </div>
            {feedPreview.length > 0 && (
              <div className="social-test-preview">
                {feedPreview.map((item) => (
                  <div key={`${item.source}:${item.externalId}`} className="social-test-preview__item">
                    <strong>@{item.author.handle}</strong>
                    <span>{item.text.slice(0, 160) || '(empty tweet)'}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </section>

        <section className="provider-detail">
          <div className="provider-section-head">
            <strong>Reader</strong>
          </div>

          <div className="settings-toggle-row">
            <div>
              <strong>Enable X Following reader</strong>
              <small>
                Controls the [social_feed] block in watchlist.toml. Agent tools stay disabled while this is off.
              </small>
            </div>
            <label className="switch-row">
              <input type="checkbox" checked={config.enabled} disabled={savingConfig} onChange={() => persistSocialEnabled(!config.enabled)} />
              <span className="switch-slider" />
            </label>
          </div>

          <div className="social-cache-form">
            <label>
              <span className="panel-label">Recent limit</span>
              <input
                className="input mono"
                value={recentLimitInput}
                onChange={(event) => setRecentLimitInput(event.target.value)}
                type="number"
                min={1}
                max={200}
                step={1}
              />
              <small>Default number of cached items returned for recent-feed reads.</small>
            </label>
            <label>
              <span className="panel-label">Retention</span>
              <input
                className="input mono"
                value={retentionDaysInput}
                onChange={(event) => setRetentionDaysInput(event.target.value)}
                type="number"
                min={1}
                max={365}
                step={1}
              />
              <small>Deletes cached tweets older than this many days after each refresh.</small>
            </label>
            <label>
              <span className="panel-label">Max cached items</span>
              <input
                className="input mono"
                value={maxItemsInput}
                onChange={(event) => setMaxItemsInput(event.target.value)}
                type="number"
                min={100}
                step={100}
              />
              <small>Caps total local SQLite feed rows after each refresh.</small>
            </label>
          </div>

          <div className="settings-action-row">
            <button
              className="shell-button primary"
              type="button"
              disabled={savingConfig || !cacheSettingsValid || !cacheSettingsChanged}
              onClick={persistCacheSettings}
            >
              {savingConfig ? <Loader2 className="spin" size={15} /> : <Save size={15} />}
              Save cache settings
            </button>
          </div>

          <div className="settings-readonly-grid compact">
            <div>
              <span className="panel-label">Auth source</span>
              <strong>
                {authStatus?.hasSavedAuth ? 'Saved local auth' : authStatus?.envAvailable ? 'Environment' : 'Missing'}
              </strong>
            </div>
          </div>

          <div className="provider-status-bar">{status}</div>
        </section>
      </div>
    </>
  );
}
