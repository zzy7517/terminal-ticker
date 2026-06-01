import { useEffect, useState } from 'react';
import { Loader2, Network, ShieldCheck } from 'lucide-react';
import type { ProxyType, ProxyTestResult } from '../../types';
import { useMarketStore } from '../../stores/marketStore';
import { saveProxyConfig, testProxy } from '../../api';

interface Draft {
  enabled: boolean;
  type: ProxyType;
  host: string;
  port: string;
  username: string;
  password: string;
}

const PROXY_TYPES: { value: ProxyType; label: string }[] = [
  { value: 'http', label: 'HTTP' },
  { value: 'https', label: 'HTTPS' },
  { value: 'socks5', label: 'SOCKS5' },
];

export function ProxySettingsPanel() {
  const state = useMarketStore((s) => s.state);
  const config = state?.config.proxy;
  const configSignature = config ? JSON.stringify(config) : '';

  const [draft, setDraft] = useState<Draft | null>(null);
  // Tracks whether the password field has been touched, so we don't overwrite a
  // saved-but-masked password with an empty string on every save.
  const [passwordDirty, setPasswordDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<ProxyTestResult | null>(null);
  const [status, setStatus] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!config) return;
    setDraft({
      enabled: config.enabled,
      type: config.type,
      host: config.host,
      port: String(config.port),
      username: config.username,
      password: '',
    });
    setPasswordDirty(false);
    setTestResult(null);
  }, [configSignature]);

  if (!config || !draft) {
    return <div className="empty-state lg">Loading settings...</div>;
  }

  const update = (patch: Partial<Draft>) => setDraft((prev) => (prev ? { ...prev, ...patch } : prev));

  function buildPayload() {
    const port = Number(draft!.port);
    return {
      type: draft!.type,
      host: draft!.host.trim(),
      port: Number.isFinite(port) && port > 0 ? port : 8080,
      username: draft!.username,
      // Only send password when the user typed something; otherwise leave the
      // saved value untouched. Empty + dirty means "clear it".
      ...(passwordDirty
        ? draft!.password
          ? { password: draft!.password }
          : { clearPassword: true }
        : {}),
    };
  }

  async function persist(nextEnabled: boolean) {
    setSaving(true);
    setError(null);
    setStatus(nextEnabled ? 'Enabling proxy...' : 'Saving...');
    try {
      const nextState = await saveProxyConfig({ enabled: nextEnabled, ...buildPayload() });
      useMarketStore.getState().setState(nextState);
      setPasswordDirty(false);
      setStatus(nextEnabled ? 'Proxy enabled — all outbound requests now route through it.' : 'Proxy disabled (direct connection).');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed');
      setStatus('');
    } finally {
      setSaving(false);
    }
  }

  async function handleTest() {
    setTesting(true);
    setTestResult(null);
    setError(null);
    setStatus('Testing proxy connection...');
    try {
      const result = await testProxy({ enabled: true, ...buildPayload() });
      setTestResult(result);
      setStatus(result.ok ? 'Proxy reachable.' : 'Proxy test failed.');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Test failed');
      setStatus('');
    } finally {
      setTesting(false);
    }
  }

  const isEnabled = config.enabled;

  return (
    <>
      <header className="settings-stage-head">
        <div>
          <div className="eyebrow">Configuration</div>
          <h2>Proxy</h2>
        </div>
        <div className="settings-stage-actions">
          <span className={`badge${isEnabled ? ' success' : ''}`}>{isEnabled ? 'Active' : 'Disabled'}</span>
        </div>
      </header>

      {error && (
        <div className="cron-error-banner">
          <span>{error}</span>
          <button type="button" onClick={() => setError(null)}>dismiss</button>
        </div>
      )}

      <div className="provider-layout">
        {/* Left: summary / info */}
        <section className="provider-catalog">
          <div className="provider-section-head">
            <strong>Outbound</strong>
          </div>
          <div className="provider-list">
            <button className="provider-item selected" type="button" disabled>
              <div className="provider-item-icon">
                <Network size={18} />
              </div>
              <div className="provider-item-body">
                <strong>Global proxy</strong>
                <small>{isEnabled ? `${config.type} · ${config.host || '—'}:${config.port}` : 'Direct connection'}</small>
              </div>
              <span className={`badge${isEnabled ? ' success' : ''}`}>{isEnabled ? 'On' : 'Off'}</span>
            </button>
          </div>
          <div className="settings-hint" style={{ padding: '0 12px', marginTop: 12 }}>
            <p style={{ margin: '4px 0', fontSize: 12, lineHeight: 1.6 }}>
              When enabled, <strong>every</strong> outbound request from the backend (LLM providers,
              news, Jin10, and the exchanges) routes through this proxy.
            </p>
            <p style={{ margin: '8px 0 0', opacity: 0.6, fontSize: 11 }}>
              Persisted to the <code>[proxy]</code> block in watchlist.toml and applied live.
            </p>
          </div>
        </section>

        {/* Right: form (mirrors the reference Proxy Settings layout) */}
        <section className="provider-detail">
          <div className="settings-toggle-row">
            <div>
              <strong>Enable Proxy</strong>
              <small>Route all backend network traffic through the proxy below.</small>
            </div>
            <label className="switch-row">
              <input
                type="checkbox"
                checked={isEnabled}
                disabled={saving}
                onChange={() => persist(!isEnabled)}
              />
              <span className="switch-slider" />
            </label>
          </div>

          <div className="provider-field">
            <span className="provider-field-label">Proxy Type</span>
            <select
              className="input"
              value={draft.type}
              onChange={(e) => update({ type: e.target.value as ProxyType })}
            >
              {PROXY_TYPES.map((t) => (
                <option key={t.value} value={t.value}>{t.label}</option>
              ))}
            </select>
          </div>

          <div className="settings-form-grid" style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 12 }}>
            <div className="provider-field">
              <span className="provider-field-label">Proxy Server</span>
              <input
                className="input mono"
                value={draft.host}
                placeholder="e.g. 127.0.0.1"
                spellCheck={false}
                onChange={(e) => update({ host: e.target.value })}
              />
            </div>
            <div className="provider-field">
              <span className="provider-field-label">Port</span>
              <input
                className="input"
                type="number"
                min={1}
                max={65535}
                value={draft.port}
                placeholder="8080"
                onChange={(e) => update({ port: e.target.value })}
              />
            </div>
          </div>

          <div className="settings-form-grid" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <div className="provider-field">
              <span className="provider-field-label">Username (Optional)</span>
              <input
                className="input"
                value={draft.username}
                placeholder="Username (Optional)"
                autoComplete="off"
                onChange={(e) => update({ username: e.target.value })}
              />
            </div>
            <div className="provider-field">
              <span className="provider-field-label">Password (Optional)</span>
              <input
                className="input"
                type="password"
                value={draft.password}
                placeholder={config.passwordConfigured && !passwordDirty ? '•••••••• (saved)' : 'Password (Optional)'}
                autoComplete="new-password"
                onChange={(e) => { setPasswordDirty(true); update({ password: e.target.value }); }}
              />
            </div>
          </div>

          <div className="provider-connection-actions" style={{ marginTop: 8, display: 'flex', gap: 8 }}>
            <button className="shell-button muted" type="button" onClick={handleTest} disabled={testing || saving || !draft.host.trim()}>
              {testing ? <Loader2 className="spin" size={14} /> : <ShieldCheck size={14} />}
              Test Proxy
            </button>
            <button className="shell-button primary" type="button" onClick={() => persist(isEnabled)} disabled={saving || testing}>
              {saving ? <Loader2 className="spin" size={14} /> : null}
              Save
            </button>
          </div>

          {testResult && (
            <div className="settings-readonly-grid" style={{ marginTop: 8 }}>
              <div>
                <span className="panel-label">Result</span>
                <strong style={{ color: testResult.ok ? 'var(--success, #2bbf6a)' : 'var(--danger, #e55)' }}>
                  {testResult.ok ? '✓ Reachable' : `✗ ${testResult.error ?? 'Failed'}`}
                </strong>
              </div>
              {testResult.status != null && (
                <div>
                  <span className="panel-label">HTTP status</span>
                  <strong>{testResult.status}</strong>
                </div>
              )}
              {testResult.latencyMs != null && (
                <div>
                  <span className="panel-label">Latency</span>
                  <strong>{testResult.latencyMs} ms</strong>
                </div>
              )}
              {testResult.url && (
                <div>
                  <span className="panel-label">Proxy URL</span>
                  <strong className="mono" style={{ fontSize: 11 }}>{testResult.url}</strong>
                </div>
              )}
            </div>
          )}

          {status && <div className="provider-status-bar">{status}</div>}
        </section>
      </div>
    </>
  );
}
