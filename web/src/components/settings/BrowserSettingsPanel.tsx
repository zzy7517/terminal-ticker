import { useEffect, useState } from 'react';
import {
  ChevronDown,
  ChevronRight,
  Chrome,
  Loader2,
  RefreshCw,
} from 'lucide-react';
import {
  fetchBrowserStatus,
  pingBrowser,
  updateBrowserSettings,
  type BrowserStatus,
  type BrowserPingResult,
} from '../../api';

export function BrowserSettingsPanel() {
  const [status, setStatus] = useState<BrowserStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [pingResult, setPingResult] = useState<BrowserPingResult | null>(null);
  const [pinging, setPinging] = useState(false);
  const [statusMsg, setStatusMsg] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [advancedOpen, setAdvancedOpen] = useState(false);

  // Advanced fields (only saved when user explicitly commits)
  const [socketPath, setSocketPath] = useState('');
  const [timeoutMs, setTimeoutMs] = useState('15000');

  useEffect(() => { loadStatus(); }, []);

  async function loadStatus() {
    setLoading(true);
    try {
      const data = await fetchBrowserStatus();
      setStatus(data);
      setSocketPath(data.socketPath ?? '');
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load status');
    } finally {
      setLoading(false);
    }
  }

  /** Toggle enabled — saves immediately like other panels */
  async function handleToggle() {
    if (!status) return;
    const nextEnabled = !status.enabled;
    setSaving(true);
    setStatusMsg(nextEnabled ? 'Enabling browser automation...' : 'Disabling...');
    setError(null);
    try {
      await updateBrowserSettings({ enabled: nextEnabled });
      // Status reflects a live OBU ping, so reloading is enough — no
      // explicit connect/disconnect step is needed.
      await loadStatus();
      setStatusMsg(nextEnabled ? 'Browser automation enabled.' : 'Browser automation disabled.');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Toggle failed');
      setStatusMsg('');
    } finally {
      setSaving(false);
    }
  }

  async function handleTestConnection() {
    setPinging(true);
    setPingResult(null);
    setError(null);
    try {
      const result = await pingBrowser();
      setPingResult(result);
      if (result.ok) {
        setStatusMsg('Connection OK — Open Browser Use is reachable.');
      } else {
        setError(result.error ?? 'Ping failed');
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Connection test failed');
    } finally {
      setPinging(false);
    }
  }

  async function handleSaveAdvanced() {
    setSaving(true);
    setError(null);
    try {
      await updateBrowserSettings({
        socketPath: socketPath.trim() || null,
        timeoutMs: Number(timeoutMs) || 15000,
      });
      setStatusMsg('Advanced settings saved.');
      await loadStatus();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  }

  const isEnabled = status?.enabled ?? false;
  const isConnected = status?.connected ?? false;

  return (
    <>
      <header className="settings-stage-head">
        <div>
          <div className="eyebrow">Configuration</div>
          <h2>Browser Automation</h2>
        </div>
        <div className="settings-stage-actions">
          <span className={`badge${isConnected ? ' success' : isEnabled ? ' warning' : ''}`}>
            {isConnected ? 'Connected' : isEnabled ? 'Disconnected' : 'Disabled'}
          </span>
          <button className="shell-button muted sm" type="button" onClick={loadStatus} disabled={loading}>
            {loading ? <Loader2 className="spin" size={14} /> : <RefreshCw size={14} />}
          </button>
        </div>
      </header>

      {error && (
        <div className="cron-error-banner">
          <span>{error}</span>
          <button type="button" onClick={() => setError(null)}>dismiss</button>
        </div>
      )}

      <div className="provider-layout">
        {/* Left: Setup guide */}
        <section className="provider-catalog">
          <div className="provider-section-head">
            <strong>Provider</strong>
          </div>
          <div className="provider-list">
            <button className="provider-item selected" type="button" disabled>
              <div className="provider-item-icon">
                <Chrome size={18} />
              </div>
              <div className="provider-item-body">
                <strong>Open Browser Use</strong>
                <small>Chrome · Local socket</small>
              </div>
              <span className={`provider-item-dot${isConnected ? '' : ' inactive'}`} />
            </button>
          </div>

          {/* Setup instructions in left panel */}
          <div className="provider-section-head" style={{ marginTop: 16 }}>
            <strong>Setup</strong>
          </div>
          <div className="settings-hint" style={{ padding: '0 12px' }}>
            <ol style={{ margin: '4px 0', paddingLeft: 18, lineHeight: 2, fontSize: 12 }}>
              <li>Install CLI<br /><code style={{ fontSize: 11 }}>npm i -g open-browser-use</code></li>
              <li>Setup native host<br /><code style={{ fontSize: 11 }}>open-browser-use setup</code></li>
              <li>Restart Chrome</li>
              <li>Verify<br /><code style={{ fontSize: 11 }}>open-browser-use ping</code></li>
            </ol>
            <p style={{ margin: '8px 0 0', opacity: 0.6, fontSize: 11 }}>
              Controls your real local Chrome. The browser must be running with the OBU extension.
            </p>
          </div>
        </section>

        {/* Right: Settings */}
        <section className="provider-detail">
          {/* Enable toggle — instant save */}
          <label className="settings-toggle-row">
            <div>
              <strong>Enable browser automation</strong>
              <small>
                Connect to Open Browser Use for chart screenshots and page scraping via your local Chrome.
              </small>
            </div>
            <button
              className={`settings-toggle ${isEnabled ? 'on' : ''}`}
              type="button"
              disabled={saving}
              onClick={handleToggle}
              aria-pressed={isEnabled}
            >
              <span />
            </button>
          </label>

          {/* Connection status */}
          {isEnabled && status && (
            <div className="settings-readonly-grid">
              <div>
                <span className="panel-label">Socket</span>
                <strong className="mono" style={{ fontSize: 11 }}>{status.socketPath ?? 'Auto-discovering...'}</strong>
              </div>
              <div>
                <span className="panel-label">Status</span>
                <strong>{isConnected ? '✓ Connected' : '✗ Not connected'}</strong>
              </div>
              {status.error && (
                <div>
                  <span className="panel-label">Error</span>
                  <strong style={{ color: 'var(--danger, #e55)' }}>{status.error}</strong>
                </div>
              )}
            </div>
          )}

          {/* Test connection button */}
          {isEnabled && (
            <div className="provider-connection-actions" style={{ marginTop: 8 }}>
              <button
                className="shell-button muted"
                type="button"
                onClick={handleTestConnection}
                disabled={pinging}
              >
                {pinging ? <Loader2 className="spin" size={14} /> : <RefreshCw size={14} />}
                Test Connection
              </button>
            </div>
          )}

          {/* Ping result */}
          {pingResult && (
            <div className="settings-readonly-grid" style={{ marginTop: 8 }}>
              <div>
                <span className="panel-label">Result</span>
                <strong>{pingResult.ok ? '✓ Open Browser Use is reachable' : `✗ ${pingResult.error ?? 'Failed'}`}</strong>
              </div>
              {pingResult.info != null && (
                <div>
                  <span className="panel-label">Host info</span>
                  <pre style={{ fontSize: 11, margin: 0, whiteSpace: 'pre-wrap', opacity: 0.8 }}>
                    {String(JSON.stringify(pingResult.info, null, 2))}
                  </pre>
                </div>
              )}
            </div>
          )}

          {/* Advanced settings — collapsed by default */}
          {isEnabled && (
            <div className="mcp-global-settings" style={{ marginTop: 16 }}>
              <button
                className="mcp-global-settings-trigger"
                type="button"
                onClick={() => setAdvancedOpen(!advancedOpen)}
              >
                {advancedOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                <span>Advanced Settings</span>
              </button>
              {advancedOpen && (
                <div className="mcp-global-settings-body">
                  <div className="provider-field">
                    <span className="provider-field-label">Socket Path</span>
                    <input
                      className="input mono"
                      value={socketPath}
                      onChange={(e) => setSocketPath(e.target.value)}
                      placeholder="Auto-discover (leave empty)"
                      spellCheck={false}
                    />
                    <span className="provider-field-hint">Override the OBU socket path. Empty = auto-discover from /tmp/open-browser-use/active.json</span>
                  </div>

                  <div className="provider-field">
                    <span className="provider-field-label">Timeout (ms)</span>
                    <input
                      className="input"
                      type="number"
                      min={1000}
                      value={timeoutMs}
                      onChange={(e) => setTimeoutMs(e.target.value)}
                      placeholder="15000"
                    />
                    <span className="provider-field-hint">Max wait time for each browser operation</span>
                  </div>

                  <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 8 }}>
                    <button
                      className="shell-button primary sm"
                      type="button"
                      onClick={handleSaveAdvanced}
                      disabled={saving}
                    >
                      {saving ? <Loader2 className="spin" size={13} /> : null}
                      Save
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}

          {statusMsg && <div className="provider-status-bar">{statusMsg}</div>}
        </section>
      </div>
    </>
  );
}
