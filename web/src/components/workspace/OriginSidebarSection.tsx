import { useEffect, useMemo, useState } from 'react';
import { Atom, Loader2, Plus, X } from 'lucide-react';
import { fetchAgentRuntimes, fetchClaudeCodeModels, fetchCursorModels } from '../../api';
import { openOriginEntry } from '../../chat/originWorkspace';
import { useAgentStore } from '../../stores/agentStore';
import { useChatStore } from '../../stores/chatStore';
import { useOriginStore } from '../../stores/originStore';
import type { AgentRuntimeId, AgentRuntimeStatus } from '../../types';
interface OriginModelChoice { id: string; efforts: string[]; defaultEffort: string }

/** Origin list and creation-time runtime snapshot controls. */
export function OriginSidebarSection() {
  const [creating, setCreating] = useState(false);
  const [runtime, setRuntime] = useState<AgentRuntimeId>('pi');
  const [provider, setProvider] = useState('');
  const [model, setModel] = useState('');
  const [effort, setEffort] = useState('');
  const [workspace, setWorkspace] = useState('');
  const [systemPrompt, setSystemPrompt] = useState('');
  const [runtimes, setRuntimes] = useState<AgentRuntimeStatus[]>([]);
  const [externalModels, setExternalModels] = useState<OriginModelChoice[]>([]);
  const activeTarget = useChatStore((state) => state.activeTarget);
  const origins = useOriginStore((state) => state.origins);
  const loading = useOriginStore((state) => state.loading);
  const registry = useAgentStore((state) => state.modelRegistry);
  const piProviders = useMemo(() => registry?.providers.filter((item) => item.runnable) ?? [], [registry]);
  const piModels = useMemo(() => registry?.models.filter((item) => item.runnable && (!provider || item.providerId === provider)) ?? [], [provider, registry]);

  useEffect(() => {
    if (creating) void fetchAgentRuntimes().then((payload) => setRuntimes(payload.runtimes));
  }, [creating]);

  useEffect(() => {
    if (!creating || runtime === 'pi') { setExternalModels([]); return; }
    if (runtime === 'claude-code') {
      void fetchClaudeCodeModels()
        .then((payload) => setExternalModels(payload.models.map((item) => ({
          id: item.id,
          efforts: item.thinking.supportedLevels,
          defaultEffort: item.thinking.defaultLevel ?? '',
        }))))
        .catch(() => setExternalModels([]));
    } else {
      void fetchCursorModels()
        .then((payload) => setExternalModels(payload.models.map((item) => ({ id: item.id, efforts: [], defaultEffort: '' }))))
        .catch(() => setExternalModels([]));
    }
  }, [creating, runtime]);

  useEffect(() => {
    if (!provider && piProviders[0]) setProvider(piProviders[0].providerId);
  }, [piProviders, provider]);

  useEffect(() => {
    if (runtime === 'pi' && piModels.length && !piModels.some((item) => item.id === model)) setModel(piModels[0].id);
  }, [model, piModels, runtime]);

  async function submit() {
    const selected = runtime === 'pi' ? piModels.find((item) => item.id === model) : null;
    const selectedProvider = selected ? registry?.providers.find((item) => item.providerId === selected.providerId) : null;
    const id = await useOriginStore.getState().create({
      runtime,
      provider: selectedProvider?.configProviderId,
      model: model || undefined,
      reasoningEffort: effort || undefined,
      workspace: workspace || undefined,
      systemPrompt: systemPrompt || undefined,
    });
    await openOriginEntry(id);
    setCreating(false);
  }

  const selectedPiModel = piModels.find((item) => item.id === model);
  const effortOptions = runtime === 'pi'
    ? selectedPiModel?.supportedReasoningEfforts ?? []
    : externalModels.find((item) => item.id === model)?.efforts ?? [];

  return <>
    <header>
      ORIGIN <span>{origins.length}</span>
      <button className="chat-sidebar-add" disabled={loading} onClick={() => setCreating((value) => !value)} title="New Origin" type="button">
        {loading ? <Loader2 className="spin" size={13} /> : creating ? <X size={13} /> : <Plus size={13} />}
      </button>
    </header>
    {creating ? <OriginCreateForm
      effort={effort} effortOptions={effortOptions} externalModels={externalModels.map((item) => item.id)} model={model} piModels={piModels.map((item) => item.id)}
      piProviders={piProviders.map((item) => ({ id: item.providerId, name: item.name }))} provider={provider}
      runtime={runtime} runtimes={runtimes} systemPrompt={systemPrompt} workspace={workspace}
      onEffort={setEffort} onModel={(value) => {
        setModel(value);
        setEffort(runtime === 'claude-code' ? externalModels.find((item) => item.id === value)?.defaultEffort ?? '' : '');
      }} onProvider={setProvider} onRuntime={(value) => { setRuntime(value); setModel(''); setEffort(''); }}
      onSubmit={() => void submit()} onSystemPrompt={setSystemPrompt} onWorkspace={setWorkspace}
    /> : null}
    {origins.map((origin) => <button
      className={`channel-sidebar-row origin-sidebar-row ${activeTarget?.kind === 'origin' && activeTarget.sessionId === origin.id ? 'active' : ''}`}
      key={origin.id} onClick={() => void openOriginEntry(origin.id)} type="button"
    >
      <Atom size={14} />
      <span className="origin-sidebar-copy"><strong>{origin.title || 'New Origin'}</strong><small>{origin.preview === '(no messages)' ? 'Ready' : origin.preview}</small></span>
      {origin.run?.status === 'running' ? <span className="direct-message-presence working" /> : null}
    </button>)}
  </>;
}

interface OriginCreateFormProps {
  runtime: AgentRuntimeId; runtimes: AgentRuntimeStatus[]; provider: string; piProviders: Array<{ id: string; name: string }>;
  model: string; piModels: string[]; externalModels: string[]; effort: string; effortOptions: string[]; workspace: string; systemPrompt: string;
  onRuntime(value: AgentRuntimeId): void; onProvider(value: string): void; onModel(value: string): void; onEffort(value: string): void;
  onWorkspace(value: string): void; onSystemPrompt(value: string): void; onSubmit(): void;
}

function OriginCreateForm(props: OriginCreateFormProps) {
  const models = props.runtime === 'pi' ? props.piModels : props.externalModels;
  return <div className="origin-create-card">
    <label>Runtime<select value={props.runtime} onChange={(event) => props.onRuntime(event.target.value as AgentRuntimeId)}>
      {(['pi', 'claude-code', 'cursor'] as const).map((id) => {
        const status = props.runtimes.find((item) => item.id === id);
        return <option disabled={status ? !status.available : false} key={id} value={id}>{id}{status && !status.available ? ' (unavailable)' : ''}</option>;
      })}
    </select></label>
    {props.runtime === 'pi' ? <label>Provider<select value={props.provider} onChange={(event) => { props.onProvider(event.target.value); props.onModel(''); }}>
      {props.piProviders.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
    </select></label> : null}
    <label>Model<select value={props.model} onChange={(event) => props.onModel(event.target.value)}>
      <option value="">Runtime default</option>{models.map((id) => <option key={id} value={id}>{id}</option>)}
    </select></label>
    {props.effortOptions.length > 0 ? <label>Reasoning<select value={props.effort} onChange={(event) => props.onEffort(event.target.value)}>
      <option value="">Default</option>{props.effortOptions.map((value) => <option key={value}>{value}</option>)}
    </select></label> : null}
    <label>Workspace<input onChange={(event) => props.onWorkspace(event.target.value)} placeholder="Current workspace" value={props.workspace} /></label>
    <label>System prompt<textarea onChange={(event) => props.onSystemPrompt(event.target.value)} placeholder="Optional session instructions" rows={2} value={props.systemPrompt} /></label>
    <button className="shell-button sm" disabled={props.runtime === 'pi' && !props.model} onClick={props.onSubmit} type="button">Create Origin</button>
  </div>;
}
