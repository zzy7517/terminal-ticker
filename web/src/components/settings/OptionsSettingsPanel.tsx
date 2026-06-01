import { useEffect, useState } from 'react';
import { Check, Plus, X } from 'lucide-react';
import './OptionsSettingsPanel.css';
import { useMarketStore } from '../../stores/marketStore';
import { saveOptionsConfig } from '../../api';
import type { OptionsConfigUpdate } from '../../api';

type EquityProvider = 'yfinance' | 'tradier' | 'marketdata';

interface ProviderMeta {
  id: EquityProvider;
  name: string;
  blurb: string;
}

const EQUITY_PROVIDERS: ProviderMeta[] = [
  { id: 'yfinance', name: 'Yahoo Finance', blurb: 'Free, no key. US equity / ETF chains (SPY, QQQ, AAPL).' },
  { id: 'marketdata', name: 'MarketData.app', blurb: 'Full Greeks + IV, instant free token. Falls back to Yahoo.' },
  { id: 'tradier', name: 'Tradier', blurb: 'Index options (SPX / VIX / RUT) + Greeks. Free sandbox token.' },
];

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
  const [marketdataApiKey, setMarketdataApiKey] = useState('');
  const [marketdataBaseUrl, setMarketdataBaseUrl] = useState('https://api.marketdata.app/v1');
  // Tuning fields are stored as strings so an empty box means "use default".
  const [marketdataStrikeLimit, setMarketdataStrikeLimit] = useState('');
  const [marketdataDte, setMarketdataDte] = useState('');
  const [marketdataCallsPerMin, setMarketdataCallsPerMin] = useState('');
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState('');
  const [statusError, setStatusError] = useState(false);

  useEffect(() => {
    if (!config) return;
    setEnabled(config.enabled);
    // 'deribit' was a legacy single-select value; treat it as yfinance here.
    setEquityProvider(config.provider === 'deribit' ? 'yfinance' : (config.provider as EquityProvider));
    setDeribitEnabled(config.deribit?.enabled ?? false);
    setSymbols(config.symbols);
    setPollInterval(config.pollIntervalSeconds);
    setStrikeRange(config.strikeRangePercent);
    if (config.tradier) setTradierBaseUrl(config.tradier.baseUrl);
    if (config.marketdata) {
      setMarketdataBaseUrl(config.marketdata.baseUrl);
      setMarketdataStrikeLimit(config.marketdata.strikeLimit != null ? String(config.marketdata.strikeLimit) : '');
      setMarketdataDte(config.marketdata.dte != null ? String(config.marketdata.dte) : '');
      setMarketdataCallsPerMin(config.marketdata.callsPerMinute != null ? String(config.marketdata.callsPerMinute) : '');
    }
  }, [configSig]);

  async function save(patch: OptionsConfigUpdate) {
    setSaving(true);
    setStatusError(false);
    setStatus('Saving…');
    try {
      const nextState = await saveOptionsConfig(patch);
      useMarketStore.getState().setState(nextState);
      setStatus('Saved.');
    } catch (err) {
      setStatusError(true);
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
    if (p === equityProvider) return;
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

  // Provider tokens + advanced fields auto-save on blur, matching the rest of
  // the page's "change = persist" model (no separate Save buttons).
  function commitTradier() {
    save({ tradier: { apiKey: tradierApiKey || undefined, baseUrl: tradierBaseUrl } });
    setTradierApiKey('');
  }

  // Empty string clears an override (null => back to default); a number sets it.
  function numOrNull(s: string): number | null {
    const t = s.trim();
    if (t === '') return null;
    const n = Number(t);
    return Number.isFinite(n) ? n : null;
  }

  function commitMarketData() {
    save({
      marketdata: {
        apiKey: marketdataApiKey || undefined,
        baseUrl: marketdataBaseUrl,
        strikeLimit: numOrNull(marketdataStrikeLimit),
        dte: numOrNull(marketdataDte),
        callsPerMinute: numOrNull(marketdataCallsPerMin),
      },
    });
    setMarketdataApiKey('');
  }

  function commitAdvanced() {
    save({ pollIntervalSeconds: pollInterval, strikeRangePercent: strikeRange });
  }

  if (!config) {
    return <div className="empty-state lg">Loading settings…</div>;
  }

  return (
    <>
      <header className="settings-stage-head">
        <div>
          <div className="eyebrow">Configuration</div>
          <h2>Options &amp; GEX</h2>
        </div>
        <div className="settings-stage-actions">
          <span className={`badge${enabled ? ' success' : ''}`}>{enabled ? 'Active' : 'Disabled'}</span>
        </div>
      </header>

      <div className="options-layout">
        {/* Master switch */}
        <div className="options-master">
          <div>
            <strong>Options &amp; GEX Analysis</strong>
            <small>Lazy-refreshed option chains, GEX calculation, and unusual-activity detection.</small>
          </div>
          <label className="switch-row">
            <input type="checkbox" checked={enabled} disabled={saving} onChange={handleToggleEnabled} />
            <span className="switch-slider" />
          </label>
        </div>

        {/* ── Data Sources ── */}
        <section className="options-group">
          <div className="options-group-title">
            <span>Data Sources</span>
            <span className="options-group-hint">Equity / ETF primary · crypto runs alongside</span>
          </div>

          <div className="options-provider-list">
            {EQUITY_PROVIDERS.map((p) => (
              <button
                key={p.id}
                type="button"
                className={`options-provider-item${equityProvider === p.id ? ' selected' : ''}`}
                onClick={() => handleEquityProviderChange(p.id)}
                disabled={saving}
              >
                <span className="name">
                  {p.name}
                  {equityProvider === p.id && <Check size={14} className="check" />}
                </span>
                <small>{p.blurb}</small>
              </button>
            ))}
          </div>

          {/* MarketData config - only when selected */}
          {equityProvider === 'marketdata' && (
            <div className="options-config">
              <div className="options-config-head">
                <strong>MarketData.app</strong>
                {config.marketdata?.apiKeyConfigured && <span className="badge success">Key set</span>}
              </div>
              <label className="provider-field">
                <span className="provider-field-label">API Token</span>
                <input
                  className="input mono"
                  type="password"
                  placeholder={config.marketdata?.apiKeyConfigured ? '••••••••  (saved)' : 'Paste token, or ${MARKETDATA_API_KEY}'}
                  value={marketdataApiKey}
                  onChange={(e) => setMarketdataApiKey(e.target.value)}
                  onBlur={() => { if (marketdataApiKey) commitMarketData(); }}
                  autoComplete="off"
                  spellCheck={false}
                />
                <span className="provider-field-hint">
                  Free token at{' '}
                  <a href="https://www.marketdata.app/dashboard/" target="_blank" rel="noreferrer">marketdata.app</a>.
                  Enter <code>{'${MARKETDATA_API_KEY}'}</code> to reference an env var without storing the secret.
                </span>
              </label>
              <label className="provider-field">
                <span className="provider-field-label">Base URL</span>
                <input
                  className="input"
                  type="text"
                  value={marketdataBaseUrl}
                  onChange={(e) => setMarketdataBaseUrl(e.target.value)}
                  onBlur={commitMarketData}
                  spellCheck={false}
                />
                <span className="provider-field-hint">API endpoint. Leave as the default unless MarketData tells you otherwise.</span>
              </label>

              <div className="options-config-grid">
                <label className="provider-field">
                  <span className="provider-field-label">Strike limit</span>
                  <input
                    className="input sm"
                    type="number"
                    min={1}
                    placeholder="80 (default)"
                    value={marketdataStrikeLimit}
                    onChange={(e) => setMarketdataStrikeLimit(e.target.value)}
                    onBlur={commitMarketData}
                  />
                  <span className="provider-field-hint">
                    Max strikes fetched per side. The free plan bills 1 credit per contract
                    (100/day), so lower = cheaper, higher = wider chain. Empty = default 80.
                  </span>
                </label>

                <label className="provider-field">
                  <span className="provider-field-label">Target DTE</span>
                  <input
                    className="input sm"
                    type="number"
                    min={0}
                    placeholder="7 (default)"
                    value={marketdataDte}
                    onChange={(e) => setMarketdataDte(e.target.value)}
                    onBlur={commitMarketData}
                  />
                  <span className="provider-field-hint">
                    Days-to-expiry to target. Picks the expiration closest to this many days
                    out (dealer hedging is most price-sensitive near-term). Empty = default 7.
                  </span>
                </label>

                <label className="provider-field">
                  <span className="provider-field-label">Calls / minute</span>
                  <input
                    className="input sm"
                    type="number"
                    min={1}
                    placeholder="auto (15-30)"
                    value={marketdataCallsPerMin}
                    onChange={(e) => setMarketdataCallsPerMin(e.target.value)}
                    onBlur={commitMarketData}
                  />
                  <span className="provider-field-hint">
                    Outbound request rate cap. The free plan is credit-bound, not rate-bound,
                    so you rarely need to change this. Empty = auto (derived from poll interval).
                  </span>
                </label>
              </div>
            </div>
          )}

          {/* Tradier config - only when selected */}
          {equityProvider === 'tradier' && (
            <div className="options-config">
              <div className="options-config-head">
                <strong>Tradier</strong>
                {config.tradier?.apiKeyConfigured && <span className="badge success">Key set</span>}
              </div>
              <label className="provider-field">
                <span className="provider-field-label">API Token (Sandbox)</span>
                <input
                  className="input mono"
                  type="password"
                  placeholder={config.tradier?.apiKeyConfigured ? '••••••••  (saved)' : 'Paste your sandbox token'}
                  value={tradierApiKey}
                  onChange={(e) => setTradierApiKey(e.target.value)}
                  onBlur={() => { if (tradierApiKey) commitTradier(); }}
                  autoComplete="off"
                  spellCheck={false}
                />
                <span className="provider-field-hint">
                  Get yours at{' '}
                  <a href="https://web.tradier.com/user/api" target="_blank" rel="noreferrer">web.tradier.com/user/api</a>.
                </span>
              </label>
              <label className="provider-field">
                <span className="provider-field-label">Base URL</span>
                <select
                  className="input"
                  value={tradierBaseUrl}
                  onChange={(e) => setTradierBaseUrl(e.target.value)}
                  onBlur={commitTradier}
                >
                  <option value="https://sandbox.tradier.com/v1">Sandbox (delayed, free)</option>
                  <option value="https://api.tradier.com/v1">Production (real-time)</option>
                </select>
                <span className="provider-field-hint">Sandbox is 15-min delayed. Production needs a funded account.</span>
              </label>
            </div>
          )}

          {/* Deribit - independent crypto toggle */}
          <div className="options-master">
            <div>
              <strong>Deribit (crypto)</strong>
              <small>Free, no key. BTC / ETH options. Runs alongside the equity provider.</small>
            </div>
            <label className="switch-row">
              <input type="checkbox" checked={deribitEnabled} disabled={saving} onChange={handleToggleDeribit} />
              <span className="switch-slider" />
            </label>
          </div>
        </section>

        {/* ── Symbols ── */}
        <section className="options-group">
          <div className="options-group-title">
            <span>Symbols</span>
            <span className="options-group-hint">{symbols.length} tracked</span>
          </div>
          <div className="options-symbols">
            <div className="options-symbol-chips">
              {symbols.map((sym) => (
                <span key={sym} className="options-symbol-chip">
                  {sym}
                  <button type="button" aria-label={`Remove ${sym}`} onClick={() => handleRemoveSymbol(sym)}>
                    <X size={12} />
                  </button>
                </span>
              ))}
            </div>
            <div className="options-symbol-add">
              <input
                className="input sm"
                type="text"
                placeholder="Add symbol (e.g. AAPL)"
                value={newSymbol}
                onChange={(e) => setNewSymbol(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleAddSymbol()}
              />
              <button className="shell-button" type="button" onClick={handleAddSymbol} disabled={saving || !newSymbol.trim()}>
                <Plus size={14} /> Add
              </button>
            </div>
          </div>
        </section>

        {/* ── Advanced ── */}
        <section className="options-group">
          <div className="options-group-title">
            <span>Advanced</span>
          </div>
          <div className="options-advanced-grid">
            <label className="provider-field">
              <span className="provider-field-label">Poll interval (seconds)</span>
              <input
                className="input sm"
                type="number"
                min={10}
                value={pollInterval}
                onChange={(e) => setPollInterval(Number(e.target.value))}
                onBlur={commitAdvanced}
              />
              <span className="provider-field-hint">Chains lazy-refresh on access; this caps freshness.</span>
            </label>
            <label className="provider-field">
              <span className="provider-field-label">Strike range (% from spot)</span>
              <input
                className="input sm"
                type="number"
                min={0.01}
                max={1}
                step={0.01}
                value={strikeRange}
                onChange={(e) => setStrikeRange(Number(e.target.value))}
                onBlur={commitAdvanced}
              />
              <span className="provider-field-hint">e.g. 0.15 = strikes within ±15% of price.</span>
            </label>
          </div>
        </section>

        <div className={`options-status${statusError ? ' error' : ''}`}>{status}</div>
      </div>
    </>
  );
}
