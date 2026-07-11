import { useEffect, useMemo, useState } from 'react';
import { Bot, Plus, Save, Trash2 } from 'lucide-react';
import { createAgent, deleteAgent, fetchAgents, updateAgent } from '../../api';
import type { AgentDefinition, AgentDefinitionInput } from '../../types';
import { useAgentStore } from '../../stores/agentStore';
import './AgentsSettingsPanel.css';

const EMPTY: AgentDefinitionInput = { id: '', name: '', description: '', systemPrompt: '', runtime: 'pi', provider: null, model: null, reasoningEffort: null };

export function AgentsSettingsPanel() {
  const [agents, setAgents] = useState<AgentDefinition[]>([]);
  const [selectedId, setSelectedId] = useState('default');
  const [draft, setDraft] = useState<AgentDefinitionInput>(EMPTY);
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const registry = useAgentStore((s) => s.modelRegistry);
  const models = useMemo(() => (registry?.models ?? []).filter((model) => model.selected && model.runnable), [registry]);

  const select = (agent: AgentDefinition) => { setCreating(false); setSelectedId(agent.id); setDraft({ id: agent.id, name: agent.name, description: agent.description, systemPrompt: agent.systemPrompt, runtime: agent.runtime, provider: agent.provider, model: agent.model, reasoningEffort: agent.reasoningEffort }); setMessage(''); };
  const load = async () => { const payload = await fetchAgents(); setAgents(payload.agents); const selected = payload.agents.find((item) => item.id === selectedId) ?? payload.agents[0]; if (selected) select(selected); };
  useEffect(() => { void load().catch((error) => setMessage(error instanceof Error ? error.message : String(error))); }, []);

  const save = async () => {
    setBusy(true); setMessage('');
    try {
      const { id: _id, ...updates } = draft;
      const payload = creating ? await createAgent(draft) : await updateAgent(selectedId, updates);
      setAgents(payload.agents); select(payload.agent); setMessage('Saved');
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  };
  const remove = async () => {
    if (!window.confirm(`Delete ${draft.name}?`)) return;
    setBusy(true); setMessage('');
    try { const payload = await deleteAgent(selectedId); setAgents(payload.agents); if (payload.agents[0]) select(payload.agents[0]); }
    catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  };
  const modelValue = draft.provider && draft.model ? `${draft.provider}:${draft.model}` : '';
  return <section className="agents-settings">
    <header><div className="eyebrow">Agent Identities</div><h2>Agents</h2><p>Create reusable identities and default models for new Sessions.</p></header>
    <div className="agents-settings-layout">
      <aside><button className="agent-add" type="button" onClick={() => { setCreating(true); setSelectedId(''); setDraft(EMPTY); setMessage(''); }}><Plus size={14}/> New Agent</button>{agents.map((agent) => <button key={agent.id} type="button" className={selectedId === agent.id && !creating ? 'active' : ''} onClick={() => select(agent)}><Bot size={15}/><span><strong>{agent.name}</strong><small>{agent.description}</small></span></button>)}</aside>
      <div className="agent-editor">
        <label>Id<input disabled={!creating} value={draft.id} onChange={(e) => setDraft({ ...draft, id: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '-') })} placeholder="market-analyst" /></label>
        <label>Name<input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} /></label>
        <label>Description<input value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} /></label>
        <label>Default model<select value={modelValue} onChange={(e) => { const selected = models.find((item) => `${item.providerId}:${item.id}` === e.target.value); setDraft({ ...draft, provider: selected?.providerId ?? null, model: selected?.id ?? null }); }}><option value="">Use global default</option>{models.map((model) => <option key={`${model.providerId}:${model.id}`} value={`${model.providerId}:${model.id}`}>{model.name} ({model.providerId})</option>)}</select></label>
        <label>Default reasoning effort<select value={draft.reasoningEffort ?? ''} onChange={(e) => setDraft({ ...draft, reasoningEffort: e.target.value || null })}><option value="">Use global default</option>{['minimal','low','medium','high','xhigh'].map((effort) => <option key={effort}>{effort}</option>)}</select></label>
        <label>System prompt<textarea rows={16} value={draft.systemPrompt ?? ''} onChange={(e) => setDraft({ ...draft, systemPrompt: e.target.value || null })} placeholder={selectedId === 'default' ? 'Empty uses the built-in MAIN_AGENT_PROMPT' : 'Describe this Agent identity and instructions'} /></label>
        {message && <div className="agent-editor-message">{message}</div>}
        <div className="agent-editor-actions"><button type="button" disabled={busy || !draft.id || !draft.name} onClick={() => void save()}><Save size={14}/> Save</button>{!creating && selectedId !== 'default' && <button className="danger" type="button" disabled={busy} onClick={() => void remove()}><Trash2 size={14}/> Delete</button>}</div>
      </div>
    </div>
  </section>;
}
