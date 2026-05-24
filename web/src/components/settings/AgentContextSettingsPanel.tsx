import { useEffect, useState } from 'react';
import { Loader2, Save } from 'lucide-react';
import { useMarketStore } from '../../stores/marketStore';
import { saveAgentConfig } from '../../api';

type CandleContextMode = 'raw' | 'with_indicators';

export function AgentContextSettingsPanel() {
  const state = useMarketStore((s) => s.state);
  const config = state?.config.agent;
  const [maxCandles, setMaxCandles] = useState(config?.maxCandles ?? 40);
  const [candleContextMode, setCandleContextMode] = useState<CandleContextMode>(config?.candleContextMode ?? 'raw');
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState('Controls how much recent candle context the agent sees.');

  useEffect(() => {
    if (!config) return;
    setMaxCandles(config.maxCandles);
    setCandleContextMode(config.candleContextMode);
  }, [config?.candleContextMode, config?.maxCandles]);

  async function saveContext() {
    if (!config) return;
    setSaving(true);
    setStatus('Saving context settings...');
    try {
      const nextState = await saveAgentConfig({
        enabled: config.enabled,
        maxCandles,
        candleContextMode,
      });
      useMarketStore.getState().setState(nextState);
      setStatus('Saved.');
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Save failed.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <header className="settings-stage-head">
        <div>
          <div className="eyebrow">Agent</div>
          <h2>Context</h2>
        </div>
      </header>
      <section className="provider-detail">
        <div className="provider-section-head">
          <strong>Market Context</strong>
          <small>Number of recent candles included in agent prompts and tools.</small>
        </div>
        <div className="provider-form-grid">
          <label>
            <span>Max Candles</span>
            <input
              className="input mono"
              min={10}
              step={5}
              type="number"
              value={maxCandles}
              onChange={(e) => setMaxCandles(Math.max(10, Number(e.target.value) || 10))}
            />
          </label>
          <label>
            <span>Candle Mode</span>
            <select
              className="input"
              value={candleContextMode}
              onChange={(e) => setCandleContextMode(e.target.value as CandleContextMode)}
            >
              <option value="raw">Raw candles</option>
              <option value="with_indicators">With indicators</option>
            </select>
          </label>
        </div>
        <div className="settings-action-row">
          <button className="shell-button primary" type="button" onClick={saveContext} disabled={saving}>
            {saving ? <Loader2 className="spin" size={16} /> : <Save size={16} />}
            Save
          </button>
          <span className="provider-status-bar">{status}</span>
        </div>
      </section>
    </>
  );
}
