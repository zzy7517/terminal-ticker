import { useEffect, useState } from 'react';
import { Bot, Loader2, X } from 'lucide-react';
import { fetchAgents } from '../../api';
import type { AgentDefinition } from '../../types';
import './AgentPicker.css';

export function AgentPicker({ onClose, onSelect }: { onClose: () => void; onSelect: (agent: AgentDefinition) => void }) {
  const [agents, setAgents] = useState<AgentDefinition[]>([]);
  const [error, setError] = useState('');
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    void fetchAgents().then((payload) => setAgents(payload.agents)).catch((err) => setError(err instanceof Error ? err.message : String(err)));
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="agent-picker-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="agent-picker" role="dialog" aria-modal="true" aria-label="Choose Agent">
        <header><div><span>NEW SESSION</span><h3>Choose an Agent</h3></div><button type="button" onClick={onClose}><X size={16} /></button></header>
        <div className="agent-picker-list">
          {!agents.length && !error && <div className="empty-state sm row"><Loader2 className="spin" size={14} /> Loading Agents</div>}
          {error && <div className="empty-state sm error">{error}</div>}
          {agents.map((agent) => (
            <button key={agent.id} type="button" className="agent-picker-card" onClick={() => onSelect(agent)}>
              <Bot size={18} /><span><strong>{agent.name}</strong><small>{agent.description}</small><em>{agent.model || 'Global default model'} · {agent.runtime}</em></span>
            </button>
          ))}
        </div>
      </section>
    </div>
  );
}
