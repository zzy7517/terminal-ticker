import { useEffect, useState } from 'react';
import { Save, X } from 'lucide-react';
import './Jin10SettingsPanel.css';
import { useMarketStore } from '../../stores/marketStore';
import { saveJin10Config, fetchJin10AvailableCodes } from '../../api';

const MASKED = '••••••••';

/**
 * Jin10 data-source settings.
 *
 * Jin10 is a market-data source, not an MCP integration — it owns its own
 * connection on the backend (`tradex/jin10/client.ts`) and is configured under
 * `[jin10]`, so it lives alongside Watchlist / News / Options rather than under
 * the MCP server list.
 */
export function Jin10SettingsPanel() {
  const config = useMarketStore((s) => s.state?.config?.jin10);
  const jin10Status = useMarketStore((s) => s.state?.jin10?.status);

  const [token, setToken] = useState('');
  const [tokenSaving, setTokenSaving] = useState(false);
  const [availCodes, setAvailCodes] = useState<Array<{ code: string; name: string }>>([]);
  const [addingCode, setAddingCode] = useState('');
  const [codeSaving, setCodeSaving] = useState(false);
  const [status, setStatus] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (config?.tokenConfigured && !token) setToken(MASKED);
  }, [config?.tokenConfigured]);

  useEffect(() => {
    if (availCodes.length > 0) return;
    fetchJin10AvailableCodes()
      .then((res) => { if (res.codes.length > 0) setAvailCodes(res.codes); })
      .catch(() => {});
  }, []);

  async function handleTokenSave() {
    if (token === MASKED || !token.trim()) return;
    setTokenSaving(true);
    try {
      const nextState = await saveJin10Config({ token: token.trim() });
      useMarketStore.getState().setState(nextState);
      setStatus('Token 已保存');
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Token save failed');
    } finally {
      setTokenSaving(false);
    }
  }

  async function handleToggle(
    field: 'enabled' | 'flash_enabled' | 'calendar_enabled' | 'quotes_enabled',
    value: boolean,
  ) {
    try {
      const nextState = await saveJin10Config({ [field]: value });
      useMarketStore.getState().setState(nextState);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Toggle failed');
    }
  }

  async function handleAddCode(code: string) {
    const normalized = code.trim().toUpperCase();
    if (!normalized) return;
    const current = config?.quotesCodes ?? [];
    if (current.includes(normalized)) return;
    setCodeSaving(true);
    setAddingCode('');
    try {
      const nextState = await saveJin10Config({ quotes_codes: [...current, normalized] });
      useMarketStore.getState().setState(nextState);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Add failed');
    } finally {
      setCodeSaving(false);
    }
  }

  async function handleRemoveCode(code: string) {
    const current = config?.quotesCodes ?? [];
    setCodeSaving(true);
    try {
      const nextState = await saveJin10Config({ quotes_codes: current.filter((c) => c !== code) });
      useMarketStore.getState().setState(nextState);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Remove failed');
    } finally {
      setCodeSaving(false);
    }
  }

  if (!config) return <div className="empty-state lg">Loading settings...</div>;

  const codes = config.quotesCodes ?? [];
  const codeNameMap = new Map(availCodes.map((item) => [item.code, item.name]));
  const suggestions = availCodes
    .filter((item) => !codes.includes(item.code))
    .filter((item) => {
      if (!addingCode) return true;
      const q = addingCode.toUpperCase();
      return item.code.includes(q) || item.name.includes(addingCode);
    });

  return (
    <>
      <header className="settings-stage-head">
        <div>
          <div className="eyebrow">Market Data</div>
          <h2>Jin10</h2>
        </div>
        <div className="settings-stage-actions">
          <span className={`badge${config.enabled ? ' success' : ''}`}>
            {config.enabled ? 'Active' : 'Disabled'}
          </span>
          {config.enabled && (
            <span className={`badge${jin10Status?.connected ? ' success' : ''}`}>
              {jin10Status?.connected ? 'Connected' : 'Disconnected'}
            </span>
          )}
        </div>
      </header>

      {error && (
        <div className="cron-error-banner">
          <span>{error}</span>
          <button type="button" onClick={() => setError(null)}>dismiss</button>
        </div>
      )}

      <div className="jin10-settings">
        {/* Token */}
        <section className="jin10-config-section">
          <div className="provider-section-head"><strong>API Token</strong></div>
          <div className="provider-field">
            <div className="jin10-token-row">
              <input
                className="input mono"
                type="password"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                onFocus={() => { if (token === MASKED) setToken(''); }}
                placeholder="sk-xxxxxxxx"
                spellCheck={false}
              />
              <button
                className="shell-button primary sm"
                type="button"
                onClick={handleTokenSave}
                disabled={tokenSaving || token === MASKED || !token.trim()}
              >
                <Save size={13} /> 保存
              </button>
            </div>
            <span className="provider-field-hint">
              从 <a href="https://mcp.jin10.com/app/" target="_blank" rel="noreferrer">mcp.jin10.com</a> 获取 Token
              {status && <> · {status}</>}
            </span>
          </div>
        </section>

        {/* Module toggles */}
        <section className="jin10-config-section">
          <div className="provider-section-head"><strong>模块开关</strong></div>
          <div className="settings-toggle-row">
            <div><strong>总开关</strong><small>启用/禁用所有 Jin10 数据</small></div>
            <label className="switch-row">
              <input type="checkbox" checked={config.enabled} onChange={() => handleToggle('enabled', !config.enabled)} />
              <span className="switch-slider" />
            </label>
          </div>
          <div className="settings-toggle-row">
            <div><strong>快讯 (Flash)</strong><small>实时财经快讯推送到 News</small></div>
            <label className="switch-row">
              <input type="checkbox" checked={config.flashEnabled} onChange={() => handleToggle('flash_enabled', !config.flashEnabled)} />
              <span className="switch-slider" />
            </label>
          </div>
          <div className="settings-toggle-row">
            <div><strong>财经日历 (Calendar)</strong><small>今日经济事件与数据发布</small></div>
            <label className="switch-row">
              <input type="checkbox" checked={config.calendarEnabled} onChange={() => handleToggle('calendar_enabled', !config.calendarEnabled)} />
              <span className="switch-slider" />
            </label>
          </div>
          <div className="settings-toggle-row">
            <div><strong>行情 (Quotes)</strong><small>商品/外汇/指数参考报价</small></div>
            <label className="switch-row">
              <input type="checkbox" checked={config.quotesEnabled} onChange={() => handleToggle('quotes_enabled', !config.quotesEnabled)} />
              <span className="switch-slider" />
            </label>
          </div>
        </section>

        {/* Quote codes */}
        {config.quotesEnabled && (
          <section className="jin10-config-section">
            <div className="provider-section-head"><strong>行情品种</strong></div>
            <div className="jin10-codes-list">
              {codes.map((code) => (
                <span key={code} className="jin10-code-chip">
                  <span className="jin10-code-chip__label">{codeNameMap.get(code) || code}</span>
                  <button
                    className="jin10-code-chip__remove"
                    type="button"
                    onClick={() => handleRemoveCode(code)}
                    disabled={codeSaving}
                    title="移除"
                  ><X size={11} /></button>
                </span>
              ))}
            </div>
            <div className="jin10-codes-add-row">
              <input
                className="input sm mono"
                value={addingCode}
                onChange={(e) => setAddingCode(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); handleAddCode(addingCode); } }}
                placeholder="输入品种代码回车添加"
                spellCheck={false}
                disabled={codeSaving}
              />
            </div>
            {suggestions.length > 0 && (
              <div className="jin10-codes-suggestions">
                <span className="jin10-codes-suggestions__label">可选品种：</span>
                <div className="jin10-codes-suggestions__list">
                  {suggestions.map((item) => (
                    <button
                      key={item.code}
                      type="button"
                      className="jin10-suggestion-chip"
                      onClick={() => handleAddCode(item.code)}
                      disabled={codeSaving}
                      title={item.code}
                    >{item.name}</button>
                  ))}
                </div>
              </div>
            )}
          </section>
        )}
      </div>
    </>
  );
}
