/** 提供 Pi 与 Claude Code Agent 的创建和编辑界面。 */
import { useEffect, useMemo, useState } from 'react';
import { Bot, Loader2, Plus, RefreshCw, Save, Trash2 } from 'lucide-react';
import { createAgent, deleteAgent, fetchAgentRuntimes, fetchAgents, fetchClaudeCodeModels, updateAgent } from '../../api';
import type { AgentDefinition, AgentDefinitionInput, AgentRuntimeStatus, ClaudeCodeModelsResponse } from '../../types';
import { useAgentStore } from '../../stores/agentStore';
import './AgentsSettingsPanel.css';
import './AgentsSettingsPanel.runtime.css';

const EMPTY: AgentDefinitionInput = { id: '', name: '', description: '', systemPrompt: '', runtime: 'pi', provider: null, model: null, reasoningEffort: null };

export function AgentsSettingsPanel() {
  const [agents, setAgents] = useState<AgentDefinition[]>([]);
  const [selectedId, setSelectedId] = useState('default');
  const [draft, setDraft] = useState<AgentDefinitionInput>(EMPTY);
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [runtimes, setRuntimes] = useState<AgentRuntimeStatus[]>([]);
  const [claudeCatalog, setClaudeCatalog] = useState<ClaudeCodeModelsResponse | null>(null);
  const [fetchingClaudeModels, setFetchingClaudeModels] = useState(false);
  const registry = useAgentStore((s) => s.modelRegistry);
  const models = useMemo(() => (registry?.models ?? []).filter((model) => model.selected && model.runnable), [registry]);

  const selectedAgent = agents.find((agent) => agent.id === selectedId) ?? null;
  const providerLocked = !creating && selectedAgent?.provider != null;
  const modelLocked = !creating && selectedAgent?.model != null;

  const select = (agent: AgentDefinition) => {
    setCreating(false);
    setSelectedId(agent.id);
    setDraft({
      id: agent.id,
      name: agent.name,
      description: agent.description,
      systemPrompt: agent.systemPrompt,
      runtime: agent.runtime,
      provider: agent.provider,
      model: agent.model,
      reasoningEffort: agent.reasoningEffort,
    });
    setMessage('');
  };
  const load = async () => {
    const payload = await fetchAgents();
    setAgents(payload.agents);
    const selected = payload.agents.find((item) => item.id === selectedId) ?? payload.agents[0];
    if (selected) select(selected);
  };
  useEffect(() => {
    void Promise.all([load(), fetchAgentRuntimes().then((payload) => setRuntimes(payload.runtimes))])
      .catch((error) => setMessage(error instanceof Error ? error.message : String(error)));
  }, []);

  const save = async () => {
    setBusy(true);
    setMessage('');
    try {
      if (creating) {
        const payload = await createAgent(draft);
        setAgents(payload.agents);
        select(payload.agent);
      } else {
        // provider/model are bind-once: omit locked fields so the API rejects only real mutations.
        const { id: _id, provider, model, ...rest } = draft;
        const updates: Partial<AgentDefinitionInput> = { ...rest };
        if (!providerLocked) updates.provider = provider;
        if (!modelLocked) updates.model = model;
        const payload = await updateAgent(selectedId, updates);
        setAgents(payload.agents);
        select(payload.agent);
      }
      setMessage('Saved');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    if (!window.confirm(`Delete ${draft.name}?`)) return;
    setBusy(true);
    setMessage('');
    try {
      const payload = await deleteAgent(selectedId);
      setAgents(payload.agents);
      if (payload.agents[0]) select(payload.agents[0]);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };
  const modelValue = draft.provider && draft.model ? `${draft.provider}:${draft.model}` : '';
  const runtimeStatus = runtimes.find((runtime) => runtime.id === draft.runtime);
  const selectedClaudeModel = claudeCatalog?.models.find((model) => model.id === draft.model) ?? null;
  const claudeEfforts = selectedClaudeModel?.thinking.supportedLevels ?? ['low', 'medium', 'high', 'xhigh', 'max'];
  const loadClaudeModels = async () => {
    setFetchingClaudeModels(true);
    setMessage('');
    try {
      const payload = await fetchClaudeCodeModels();
      setClaudeCatalog(payload);
      setMessage(payload.models.length ? `Loaded ${payload.models.length} Claude Code model options.` : 'No known models; enter a full model ID.');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setFetchingClaudeModels(false);
    }
  };
  useEffect(() => {
    if (draft.runtime !== 'claude-code' || claudeCatalog || fetchingClaudeModels) return;
    void loadClaudeModels();
  }, [draft.runtime, claudeCatalog, fetchingClaudeModels]);

  const piModelSelectDisabled = providerLocked && modelLocked;
  const canSave = Boolean(draft.id && draft.name)
    && (draft.runtime !== 'pi' || Boolean(draft.provider && draft.model));

  return <section className="agents-settings">
    <header>
      <div className="eyebrow">Agent Identities</div>
      <h2>Agents</h2>
      <p>Create reusable identities. Model is chosen at creation and stays fixed.</p>
    </header>
    <div className="agents-settings-layout ui-surface">
      <aside>
        <button className="agent-add" type="button" onClick={() => { setCreating(true); setSelectedId(''); setDraft(EMPTY); setMessage(''); }}>
          <Plus size={14}/> New Agent
        </button>
        {agents.map((agent) => (
          <button key={agent.id} type="button" className={selectedId === agent.id && !creating ? 'active' : ''} onClick={() => select(agent)}>
            <Bot size={15}/>
            <span><strong>{agent.name}</strong><small>{agent.description}</small></span>
          </button>
        ))}
      </aside>
      <div className="agent-editor">
        <div className="agent-editor-fields">
        <label>Id<input disabled={!creating} value={draft.id} onChange={(e) => setDraft({ ...draft, id: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '-') })} placeholder="market-analyst" /></label>
        <label>Name<input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} /></label>
        <label>Description<input value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} /></label>
        <label>Runtime<select disabled={!creating && selectedId === 'default'} value={draft.runtime} onChange={(e) => {
          const runtime = e.target.value as AgentDefinitionInput['runtime'];
          setDraft({ ...draft, runtime, provider: runtime === 'claude-code' ? null : draft.provider, model: null, reasoningEffort: null });
        }}><option value="pi">Pi SDK</option><option value="claude-code">Claude Code (local CLI)</option></select></label>
        {runtimeStatus && <div className="agent-editor-message">{runtimeStatus.available ? `Available${runtimeStatus.version ? ` · ${runtimeStatus.version}` : ''}` : `Unavailable · ${runtimeStatus.error ?? 'CLI not found'}`}</div>}
        {draft.runtime === 'pi' ? <>
          <label>
            Model
            <select
              disabled={piModelSelectDisabled}
              value={modelValue}
              onChange={(e) => {
                const selected = models.find((item) => `${item.providerId}:${item.id}` === e.target.value);
                setDraft({ ...draft, provider: selected?.providerId ?? null, model: selected?.id ?? null });
              }}
            >
              {!modelValue && <option value="" disabled>Select a model</option>}
              {models.map((model) => (
                <option key={`${model.providerId}:${model.id}`} value={`${model.providerId}:${model.id}`}>
                  {model.name} ({model.providerId})
                </option>
              ))}
            </select>
          </label>
          <label>Reasoning effort<select value={draft.reasoningEffort ?? ''} onChange={(e) => setDraft({ ...draft, reasoningEffort: e.target.value || null })}><option value="">Use global default</option>{['minimal','low','medium','high','xhigh'].map((effort) => <option key={effort}>{effort}</option>)}</select></label>
        </> : <>
          <div className="claude-agent-model-field">
            <label>Claude model
              <select
                disabled={modelLocked}
                value={selectedClaudeModel?.id ?? ''}
                onChange={(e) => {
                  const selected = claudeCatalog?.models.find((model) => model.id === e.target.value);
                  setDraft({ ...draft, model: selected?.id ?? null, reasoningEffort: selected?.thinking.defaultLevel ?? null });
                }}
              >
                {!modelLocked && <option value="">Use local CLI default</option>}
                {claudeCatalog?.models.map((model) => (
                  <option key={model.id} value={model.id}>{model.label}{model.default ? ' · recommended' : ''}</option>
                ))}
              </select>
            </label>
            <button type="button" className="agent-model-fetch" disabled={fetchingClaudeModels || !runtimeStatus?.available || modelLocked} onClick={() => void loadClaudeModels()}>
              {fetchingClaudeModels ? <Loader2 className="spin" size={14}/> : <RefreshCw size={14}/>} Fetch
            </button>
          </div>
          <label>Full Claude model ID
            <input
              disabled={modelLocked || Boolean(selectedClaudeModel)}
              value={selectedClaudeModel ? '' : draft.model ?? ''}
              onChange={(e) => setDraft({ ...draft, model: e.target.value || null })}
              placeholder="Optional custom model ID"
            />
          </label>
          <label>Claude effort<select value={draft.reasoningEffort ?? ''} onChange={(e) => setDraft({ ...draft, reasoningEffort: e.target.value || null })}><option value="">Use local CLI default</option>{claudeEfforts.map((effort) => <option key={effort}>{effort}</option>)}</select></label>
        </>}
        <label className="agent-editor-prompt">
          {draft.runtime === 'claude-code' ? 'Instructions appended to Claude Code' : 'System prompt'}
          <textarea
            rows={12}
            value={draft.systemPrompt ?? ''}
            onChange={(e) => setDraft({ ...draft, systemPrompt: e.target.value || null })}
            placeholder={selectedId === 'default' ? 'Empty uses the built-in MAIN_AGENT_PROMPT' : 'Describe this Agent identity and instructions'}
          />
        </label>
        </div>
        <div className="agent-editor-footer">
          {message && <div className="agent-editor-message">{message}</div>}
          <div className="agent-editor-actions">
            <button type="button" disabled={busy || !canSave} onClick={() => void save()}><Save size={14}/> Save</button>
            {!creating && selectedId !== 'default' && <button className="danger" type="button" disabled={busy} onClick={() => void remove()}><Trash2 size={14}/> Delete</button>}
          </div>
        </div>
      </div>
    </div>
  </section>;
}
