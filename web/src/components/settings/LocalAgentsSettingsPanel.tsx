import { useEffect, useState } from 'react';
import { Bot, Check, RefreshCw, Terminal } from 'lucide-react';
import { fetchAgentRuntimes } from '../../api';
import type { AgentRuntimeStatus } from '../../types';
import { ProviderSettingsPanel } from './ProviderSettingsPanel';
import './LocalAgentsSettingsPanel.css';

type RuntimeTab = 'pi' | 'claude-code' | 'cursor';

export function LocalAgentsSettingsPanel() {
  const [activeRuntime, setActiveRuntime] = useState<RuntimeTab>('pi');
  const [runtimes, setRuntimes] = useState<AgentRuntimeStatus[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [message, setMessage] = useState('');

  useEffect(() => {
    void fetchAgentRuntimes()
      .then((payload) => setRuntimes(payload.runtimes))
      .catch((error) => setMessage(error instanceof Error ? error.message : String(error)));
  }, []);

  const claude = runtimes.find((runtime) => runtime.id === 'claude-code');
  const cursor = runtimes.find((runtime) => runtime.id === 'cursor');
  const activeExternal = activeRuntime === 'cursor' ? cursor : claude;

  async function refreshRuntime() {
    setRefreshing(true);
    setMessage('');
    try {
      const payload = await fetchAgentRuntimes();
      setRuntimes(payload.runtimes);
      const status = payload.runtimes.find((runtime) => runtime.id === activeRuntime);
      const label = activeRuntime === 'cursor' ? 'Cursor CLI' : 'Claude Code';
      setMessage(status?.available ? `${label} runtime refreshed.` : status?.error ?? `${label} is unavailable.`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setRefreshing(false);
    }
  }

  return (
    <section className="local-agents-settings">
      <header className="settings-stage-head local-agents-head">
        <div>
          <div className="eyebrow">Execution</div>
          <h2>Runtimes</h2>
          <p>Configure the runtimes that execute Agent identities on this machine.</p>
        </div>
      </header>

      <div className="runtime-tabs" role="tablist" aria-label="Local agent runtimes">
        <button className={activeRuntime === 'pi' ? 'active' : ''} type="button" onClick={() => setActiveRuntime('pi')}>
          <Bot size={18} />
          <span><strong>Pi SDK</strong><small>Built-in runtime and API providers</small></span>
          <i className="runtime-built-in">Built-in</i>
        </button>
        <button className={activeRuntime === 'claude-code' ? 'active' : ''} type="button" onClick={() => setActiveRuntime('claude-code')}>
          <Terminal size={18} />
          <span><strong>Claude Code</strong><small>Local CLI and subscription runtime</small></span>
          <i className={claude?.available ? 'runtime-dot available' : 'runtime-dot'} />
        </button>
        <button className={activeRuntime === 'cursor' ? 'active' : ''} type="button" onClick={() => setActiveRuntime('cursor')}>
          <Terminal size={18} />
          <span><strong>Cursor CLI</strong><small>Local agent CLI (`cursor-agent`)</small></span>
          <i className={cursor?.available ? 'runtime-dot available' : 'runtime-dot'} />
        </button>
      </div>

      {activeRuntime === 'pi' ? <ProviderSettingsPanel embedded /> : (
        <div className="claude-runtime-panel">
          <section className="claude-runtime-status">
            <div>
              <span className="runtime-kicker">Local CLI</span>
              <h3>{activeRuntime === 'cursor' ? 'Cursor Agent' : 'Claude Code'}</h3>
              <p>{activeExternal?.executablePath ?? (activeRuntime === 'cursor' ? 'cursor-agent' : 'claude')}</p>
            </div>
            <span className={`runtime-status-badge ${activeExternal?.available ? 'available' : ''}`}>
              {activeExternal?.available ? <Check size={14} /> : null}
              {activeExternal?.available ? activeExternal.version ?? 'Available' : activeExternal?.error ?? 'Not detected'}
            </span>
          </section>

          <section className="claude-runtime-actions">
            <div>
              <span className="runtime-kicker">Runtime health</span>
              <p>
                {activeRuntime === 'cursor'
                  ? 'Requires Cursor Agent CLI on this machine. Model overrides are selected per Agent identity.'
                  : 'Model and effort overrides are selected per Agent identity.'}
              </p>
            </div>
            <button className="shell-button muted" type="button" disabled={refreshing} onClick={() => void refreshRuntime()}>
              <RefreshCw className={refreshing ? 'spin' : ''} size={15} /> Refresh
            </button>
          </section>
          {message ? <div className="agent-editor-message">{message}</div> : null}
        </div>
      )}
    </section>
  );
}
