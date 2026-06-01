import { useEffect, useState } from 'react';
import { Activity, Plus, X } from 'lucide-react';
import { useMarketStore } from '../../stores/marketStore';
import { saveOptionsConfig } from '../../api';
import type { OptionsConfigUpdate } from '../../api';

type EquityProvider = 'yfinance' | 'tradier';

export function OptionsSettingsPanel() {
  const state = useMarketStore((s) => s.state);
  const config = state?.config.options;
  const configSig = config ? JSON.stringify(config) : '';

  const [enabled, setEnabled] = useState(false);
  const [equityProvider, setEquityProvider] = useState<EquityProvider>('yfinance');
  const [deribitEnabled, setDeribitEnabled] = useState(false);
  const [symbols, setSymbols] = useState<string[]>([]);
  const [newSymbol, setNewSymbol] = useState('');
  const [pollInterval, setPollInterval] = useState(60);
  const [strikeRange, setStrikeRange] = useState(0.15);
  const [tradierApiKey, setTradierApiKey] = useState('');
  const [tradierBaseUrl, setTradierBaseUrl] = useState('https://sandbox.tradier.com/v1');
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState('');

  useEffect(() => {
    if (!config) return;
    setEnabled(config.enabled);
    // If provider is 'deribit' (legacy single-select), treat as yfinance + deribit enabled
    setEquityProvider(config.provider === 'deribit' ? 'yfinance' : config.provider as EquityProvider);
    setDeribitEnabled(config.deribit?.enabled ?? false);
    setSymbols(config.symbols);
    setPollInterval(config.pollIntervalSeconds);
    setStrikeRange(config.strikeRangePercent);
    if (config.tradier) {
      setTradierBaseUrl(config.tradier.baseUrl);
    }
  }, [configSig]);

  async function save(patch: OptionsConfigUpdate) {
    setSaving(true);
    setStatus('Saving...');
    try {
      const nextState = await saveOptionsConfig(patch);
      useMarketStore.getState().setState(nextState);
      setStatus('Saved.');
    } catch (err) {
      setStatus(err instanceof Error ? err.message : 'Save failed.');
    } finally {
      setSaving(false);
    }
  }

  function handleToggleEnabled() {
    const next = !enabled;
    setEnabled(next);
    save({ enabled: next });
  }

  function handleEquityProviderChange(p: EquityProvider) {
    setEquityProvider(p);
    save({ provider: p });
  }

  function handleToggleDeribit() {
    const next = !deribitEnabled;
    setDeribitEnabled(next);
    save({ deribit: { enabled: next } });
  }

  function handleAddSymbol() {
    const sym = newSymbol.trim().toUpperCase();
    if (!sym || symbols.includes(sym)) return;
    const next = [...symbols, sym];
    setSymbols(next);
    setNewSymbol('');
    save({ symbols: next });
  }

  function handleRemoveSymbol(sym: string) {
    const next = symbols.filter((s) => s !== sym);
    setSymbols(next);
    save({ symbols: next });
  }

  function handleSaveTradier() {
    save({ tradier: { apiKey: tradierApiKey || undefined, baseUrl: tradierBaseUrl } });
    setTradierApiKey('');
  }

  function handleSaveAdvanced() {
    save({ pollIntervalSeconds: pollInterval, strikeRangePercent: strikeRange });
  }

  if (!config) {
    return <div className="empty-state lg">Loading settings...</div>;
  }

  return (
    <>
      <header className="settings-stage-head">
        <div>
          <div className="eyebrow">Configuration</div>
          <h2>Options & GEX</h2>
        </div>
        <div className="settings-stage-actions">
          <span className={`badge${enabled ? ' success' : ''}`}>{enabled ? 'Active' : 'Disabled'}</span>
        </div>
      </header>

      <div className="provider-layout">
        {/* Master Enable/Disable */}
        <div className="settings-toggle-row">
          <div>
            <strong>Options & GEX Analysis</strong>
            <small>Enable options chain polling, GEX calculation, and unusual activity detection.</small>
          </div>
          <label className="switch-row">
            <input type="checkbox" checked={enabled} disabled={saving} onChange={handleToggleEnabled} />
            <span className="switch-slider" />
          </label>
        </div>

        {/* ── Equity/ETF Provider ── */}
        <section className="provider-catalog" style={{ marginTop: '1rem' }}>
          <div className="provider-section-head">
            <strong>Equity / ETF Options</strong>
            <span className="badge success">{equityProvider === 'yfinance' ? 'Yahoo Finance' : 'Tradier'}</span>
          </div>

          <div className="provider-list">
            <button
              className={`provider-item${equityProvider === 'yfinance' ? ' selected' : ''}`}
              type="button"
              onClick={() => handleEquityProviderChange('yfinance')}
              disabled={saving}
            >
              <div className="provider-item-icon"><Activity size={18} /></div>
              <div className="provider-item-copy">
                <strong>Yahoo Finance</strong>
                <small>Free, no API key. US equity/ETF options (SPY, QQQ, AAPL...).</small>
              </div>
              <span className={`badge${equityProvider === 'yfinance' ? ' success' : ''}`}>
                {equityProvider === 'yfinance' ? 'Active' : 'Select'}
              </span>
            </button>

            <button
              className={`provider-item${equityProvider === 'tradier' ? ' selected' : ''}`}
              type="button"
              onClick={() => handleEquityProviderChange('tradier')}
              disabled={saving}
            >
              <div className="provider-item-icon"><Activity size={18} /></div>
              <div className="provider-item-copy">
                <strong>Tradier</strong>
                <small>Index options (SPX/VIX/RUT) + Greeks from ORATS. Requires free sandbox token.</small>
              </div>
              <span className={`badge${equityProvider === 'tradier' ? ' success' : ''}`}>
                {equityProvider === 'tradier' ? 'Active' : 'Select'}
              </span>
            </button>
          </div>
        </section>

        {/* Tradier Config (separate section, shown when tradier selected) */}
        {equityProvider === 'tradier' && (
          <section className="provider-detail" style={{ marginTop: '1rem' }}>
            <div className="provider-section-head">
              <strong>Tradier Configuration</strong>
              {config.tradier?.apiKeyConfigured && <span className="badge success">Key Set</span>}
            </div>

            <div className="provider-connection-form">
              <label className="provider-field">
                <span className="provider-field-label">API Token (Sandbox)</span>
                <input
                  className="input mono"
                  type="password"
                  placeholder={config.tradier?.apiKeyConfigured ? '••••••••  (saved)' : 'Paste your sandbox token'}
                  value={tradierApiKey}
                  onChange={(e) => setTradierApiKey(e.target.value)}
                  autoComplete="off"
                  spellCheck={false}
                />
                <span className="provider-field-hint">
                  Get yours at{' '}
                  <a href="https://web.tradier.com/user/api" target="_blank" rel="noreferrer">
                    web.tradier.com/user/api
                  </a>
                </span>
              </label>

              <label className="provider-field">
                <span className="provider-field-label">Base URL</span>
                <select
                  className="input"
                  value={tradierBaseUrl}
                  onChange={(e) => setTradierBaseUrl(e.target.value)}
                >
                  <option value="https://sandbox.tradier.com/v1">Sandbox (delayed, free)</option>
                  <option value="https://api.tradier.com/v1">Production (real-time)</option>
                </select>
                <span className="provider-field-hint">
                  Sandbox gives 15-min delayed data. Production requires a funded account.
                </span>
              </label>

              <div className="settings-action-row">
                <button
                  className="shell-button primary"
                  type="button"
                  onClick={handleSaveTradier}
                  disabled={saving}
                >
                  Save Tradier Config
                </button>
              </div>
            </div>
          </section>
        )}

        {/* ── Deribit (Crypto) — Independent Toggle ── */}
        <section className="provider-catalog" style={{ marginTop: '1rem' }}>
          <div className="provider-section-head">
            <strong>Crypto Options (Deribit)</strong>
            <span className={`badge${deribitEnabled ? ' success' : ''}`}>{deribitEnabled ? 'On' : 'Off'}</span>
          </div>

          <div className="settings-toggle-row">
            <div>
              <strong>Deribit</strong>
              <small>Free, no API key. BTC/ETH options from Deribit. Runs alongside the equity provider.</small>
            </div>
            <label className="switch-row">
              <input type="checkbox" checked={deribitEnabled} disabled={saving} onChange={handleToggleDeribit} />
              <span className="switch-slider" />
            </label>
          </div>
        </section>

        {/* ── Symbols ── */}
        <section className="provider-catalog" style={{ marginTop: '1rem' }}>
          <div className="provider-section-head">
            <strong>Symbols</strong>
            <span className="badge">{symbols.length}</span>
          </div>
          <div style={{ padding: '8px 10px' }}>
            <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', marginBottom: '8px' }}>
              {symbols.map((sym) => (
                <span key={sym} className="badge" style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
                  {sym}
                  <button
                    type="button"
                    onClick={() => handleRemoveSymbol(sym)}
                    style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0, lineHeight: 1, color: 'inherit' }}
                  >
                    <X size={12} />
                  </button>
                </span>
              ))}
            </div>
            <div style={{ display: 'flex', gap: '6px' }}>
              <input
                className="input sm"
                type="text"
                placeholder="Add symbol (e.g. AAPL)"
                value={newSymbol}
                onChange={(e) => setNewSymbol(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleAddSymbol()}
                style={{ flex: 1 }}
              />
              <button
                className="shell-button"
                type="button"
                onClick={handleAddSymbol}
                disabled={saving || !newSymbol.trim()}
              >
                <Plus size={14} /> Add
              </button>
            </div>
          </div>
        </section>

        {/* ── Advanced ── */}
        <section className="provider-detail" style={{ marginTop: '1rem' }}>
          <div className="provider-section-head">
            <strong>Advanced</strong>
          </div>

          <label className="provider-field">
            <span className="provider-field-label">Poll Interval (seconds)</span>
            <input
              className="input sm"
              type="number"
              min={10}
              max={600}
              value={pollInterval}
              onChange={(e) => setPollInterval(Number(e.target.value))}
            />
          </label>

          <label className="provider-field">
            <span className="provider-field-label">Strike Range (% from spot)</span>
            <input
              className="input sm"
              type="number"
              min={0.01}
              max={1}
              step={0.01}
              value={strikeRange}
              onChange={(e) => setStrikeRange(Number(e.target.value))}
            />
            <span className="provider-field-hint">
              e.g. 0.15 = fetch strikes within ±15% of current price.
            </span>
          </label>

          <div className="settings-action-row">
            <button
              className="shell-button primary"
              type="button"
              onClick={handleSaveAdvanced}
              disabled={saving}
            >
              Save
            </button>
          </div>
        </section>

        {status && (
          <div style={{ marginTop: '0.75rem', padding: '4px 10px', opacity: 0.7, fontSize: '13px' }}>
            {status}
          </div>
        )}
      </div>
    </>
  );
}
