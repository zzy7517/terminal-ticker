import { useEffect, useRef, useState } from 'react';
import { Clock, Plus, Trash2, Save, ChevronDown, Search, Check, Cpu } from 'lucide-react';
import { ProviderIcon } from '../ProviderIcon';
import './CronSettingsPanel.css';
import './ModelPicker.css';
import type { CronJobStatus } from '../../types';
import { useAgentStore } from '../../stores/agentStore';
import {
  fetchCronJobs,
  createCronJob,
  updateCronJob,
  deleteCronJob,
  setCronJobEnabled,
} from '../../api';
import {
  cronToHuman,
  humanToCron,
  CRON_PRESET_GROUPS,
  TIMEZONE_OPTIONS,
  parseCronFields,
  buildCronFromFields,
  type CronFields,
} from '../../cronHuman';

interface JobDraft {
  name: string;
  cron: string;
  systemPrompt: string;
  useMainPrompt: boolean;
  userMessage: string;
  model: string | null;
  enabled: boolean;
  maxIterations: number | null;
  maxCandles: number | null;
  tradingEnabled: boolean;
  timezone: string | null;
}

const EMPTY_DRAFT: JobDraft = {
  name: '',
  cron: '0 8 * * 1-5',
  systemPrompt: '',
  useMainPrompt: true,
  userMessage: '开始定时看盘分析',
  model: null,
  enabled: true,
  maxIterations: null,
  maxCandles: null,
  tradingEnabled: false,
  timezone: null,
};

function CronModelPicker({ value, onChange }: { value: string | null; onChange: (v: string | null) => void }) {
  const registry = useAgentStore((s) => s.modelRegistry);
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) { setOpen(false); setSearch(''); }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [open]);

  const enabledProviders = (registry?.providers ?? []).filter((provider) =>
    registry?.models.some((model) => model.providerId === provider.providerId && model.selected && model.runnable),
  );
  const kw = search.trim().toLowerCase();
  const providerForValue = value?.includes(':') ? value.split(':')[0] : null;
  const modelSlugForValue = value?.includes(':') ? value.split(':').slice(1).join(':') : value;

  return (
    <div className="settings-model-picker" ref={ref}>
      <span className="settings-model-picker-label">Model</span>
      <button className="settings-model-trigger" type="button" onClick={() => setOpen(!open)}>
        {providerForValue ? (
          <span className="settings-model-provider-icon">
            <ProviderIcon provider={providerForValue} size={13} />
          </span>
        ) : (
          <span className="settings-model-provider-icon"><Cpu size={11} /></span>
        )}
        <span className="settings-model-trigger-text">{modelSlugForValue || 'Agent default'}</span>
        <ChevronDown size={13} />
      </button>
      {open && (
        <div className="settings-model-dropdown">
          <div className="settings-model-dropdown-search">
            <Search size={13} />
            <input autoFocus value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search models..." />
          </div>
          <div className="settings-model-dropdown-list">
            <button className={`settings-model-option ${!value ? 'active' : ''}`} type="button"
              onClick={() => { onChange(null); setOpen(false); setSearch(''); }}>
              {!value && <Check size={12} />}
              <span>Agent default</span>
              <span className="settings-model-option-hint">inherit</span>
            </button>
            {enabledProviders.map((opt) => {
              const models = (registry?.models ?? []).filter((model) =>
                model.providerId === opt.providerId
                && model.selected
                && model.runnable
                && (!kw || model.id.toLowerCase().includes(kw) || model.name.toLowerCase().includes(kw)));
              if (!models.length) return null;
              return (
                <div key={opt.providerId} className="settings-model-group">
                  <div className="settings-model-group-head">
                    <ProviderIcon provider={opt.providerId} size={13} />
                    <span>{opt.name}</span>
                  </div>
                  {models.map((model) => {
                    const fullSlug = `${opt.providerId}:${model.id}`;
                    const isActive = value === fullSlug;
                    return (
                      <button key={model.id} className={`settings-model-option ${isActive ? 'active' : ''}`} type="button"
                        onClick={() => { onChange(fullSlug); setOpen(false); setSearch(''); }}>
                        {isActive && <Check size={12} />}
                        <span>{model.name || model.id}</span>
                      </button>
                    );
                  })}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

export function CronSettingsPanel() {
  const [jobs, setJobs] = useState<CronJobStatus[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState<JobDraft>(EMPTY_DRAFT);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState('');
  const [showPresets, setShowPresets] = useState(false);
  const [scheduleInput, setScheduleInput] = useState('');
  const [deleteConfirm, setDeleteConfirm] = useState(false);

  useEffect(() => {
    loadJobs();
  }, []);

  async function loadJobs() {
    try {
      setLoading(true);
      const data = await fetchCronJobs();
      setJobs(data.jobs);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load');
    } finally {
      setLoading(false);
    }
  }

  function selectJob(name: string) {
    const job = jobs.find((j) => j.name === name);
    if (!job) return;
    setSelected(name);
    setCreating(false);
    setDeleteConfirm(false);
    setDraft({
      name: job.name,
      cron: job.cron,
      systemPrompt: job.systemPrompt,
      useMainPrompt: job.useMainPrompt ?? false,
      userMessage: job.userMessage,
      model: job.model,
      enabled: job.enabled,
      maxIterations: job.maxIterations,
      maxCandles: job.maxCandles,
      tradingEnabled: job.tradingEnabled,
      timezone: job.timezone,
    });
    setScheduleInput(cronToHuman(job.cron, job.timezone));
    setStatus('');
  }

  function startCreate() {
    setSelected(null);
    setCreating(true);
    setDeleteConfirm(false);
    setDraft({ ...EMPTY_DRAFT });
    setScheduleInput(cronToHuman(EMPTY_DRAFT.cron));
    setStatus('');
  }

  function handleScheduleChange(value: string) {
    setScheduleInput(value);
    const parsed = humanToCron(value);
    if (parsed) setDraft((d) => ({ ...d, cron: parsed }));
  }

  function applyPreset(cron: string, suggestedTz?: string | null) {
    const tz = suggestedTz !== undefined ? suggestedTz : draft.timezone;
    setDraft((d) => ({ ...d, cron, timezone: tz ?? d.timezone }));
    setScheduleInput(cronToHuman(cron, tz));
    setShowPresets(false);
  }

  function handleFieldChange(field: keyof CronFields, value: string) {
    const fields = parseCronFields(draft.cron);
    fields[field] = value;
    const cron = buildCronFromFields(fields);
    setDraft((d) => ({ ...d, cron }));
    setScheduleInput(cronToHuman(cron, draft.timezone));
  }

  async function handleSave() {
    if (!draft.name.trim()) { setError('任务名称不能为空'); return; }
    if (!draft.cron.trim()) { setError('Cron 表达式不能为空'); return; }
    setSaving(true);
    setError(null);
    try {
      const payload = {
        name: draft.name.trim(),
        cron: draft.cron.trim(),
        systemPrompt: draft.systemPrompt,
        useMainPrompt: draft.useMainPrompt,
        userMessage: draft.userMessage || '开始定时看盘分析',
        model: draft.model,
        enabled: draft.enabled,
        maxIterations: draft.maxIterations,
        maxCandles: draft.maxCandles,
        tradingEnabled: draft.tradingEnabled,
        timezone: draft.timezone,
      };
      let updated: CronJobStatus[];
      if (creating) {
        updated = await createCronJob(payload);
        setStatus('已创建');
      } else if (selected) {
        updated = await updateCronJob(selected, payload);
        setStatus('已保存');
      } else return;
      setJobs(updated);
      const savedName = draft.name.trim();
      setSelected(savedName);
      setCreating(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (!selected) return;
    if (!deleteConfirm) { setDeleteConfirm(true); return; }
    setSaving(true);
    try {
      const updated = await deleteCronJob(selected);
      setJobs(updated);
      setSelected(null);
      setCreating(false);
      setDeleteConfirm(false);
      setDraft({ ...EMPTY_DRAFT });
      setStatus('已删除');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Delete failed');
    } finally {
      setSaving(false);
    }
  }

  const activeJob = selected ? jobs.find((j) => j.name === selected) : null;
  const showEditor = creating || activeJob;

  return (
    <>
      <header className="settings-stage-head">
        <div>
          <div className="eyebrow">Configuration</div>
          <h2>Scheduled Tasks</h2>
        </div>
        <div className="settings-stage-actions">
          <span className="badge">{jobs.filter((j) => j.enabled).length} active</span>
        </div>
      </header>

      <div className="provider-layout">
        {/* Left: job list */}
        <section className="provider-catalog">
          <div className="provider-toolbar">
            <strong>Jobs</strong>
            <button className="shell-button sm" type="button" onClick={startCreate}>
              <Plus size={14} /> Add
            </button>
          </div>

          <div className="provider-list">
            {loading && <div className="empty-state sm">Loading...</div>}
            {!loading && jobs.length === 0 && (
              <div className="empty-state">No scheduled tasks yet</div>
            )}
            {jobs.map((job) => (
              <button
                key={job.name}
                type="button"
                className={`provider-item${selected === job.name ? ' selected' : ''}`}
                onClick={() => selectJob(job.name)}
              >
                <div className="provider-item-icon">
                  <Clock size={18} />
                </div>
                <div className="provider-item-copy">
                  <strong>{job.name}</strong>
                  <small>{cronToHuman(job.cron, job.timezone)}</small>
                </div>
                <label className="switch-row" onClick={(e) => e.stopPropagation()}>
                  <input
                    type="checkbox"
                    checked={job.enabled}
                    onChange={async () => {
                      try {
                        const updated = await setCronJobEnabled(job.name, !job.enabled);
                        setJobs(updated);
                        if (selected === job.name) setDraft((d) => ({ ...d, enabled: !job.enabled }));
                      } catch (err) {
                        setError(err instanceof Error ? err.message : 'Toggle failed');
                      }
                    }}
                  />
                  <span className="switch-slider" />
                </label>
              </button>
            ))}
          </div>
        </section>

        {/* Right: editor */}
        <section className="provider-detail">
          {!showEditor ? (
            <div className="empty-state lg">
              Select a task to edit, or click Add to create one.
            </div>
          ) : (
            <>
              <div className="provider-section-head">
                <strong>{creating ? 'New Task' : draft.name}</strong>
              </div>

              {error && (
                <div className="cron-error-banner" style={{ marginBottom: 0 }}>
                  <span>{error}</span>
                  <button type="button" onClick={() => setError(null)}>dismiss</button>
                </div>
              )}

              <div className="provider-connection-form">
                {/* Name */}
                <div className="provider-field">
                  <span className="provider-field-label">任务名称</span>
                  <input
                    className="input"
                    value={draft.name}
                    onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
                    placeholder="e.g. BTC 盘前扫描"
                  />
                </div>

                {/* Schedule */}
                <div className="provider-field">
                  <span className="provider-field-label">
                    执行时间
                    <em>{draft.cron}</em>
                  </span>
                  <div style={{ position: 'relative' }}>
                    <div style={{ display: 'flex', gap: 6 }}>
                      <input
                        className="input"
                        style={{ flex: 1 }}
                        value={scheduleInput}
                        onChange={(e) => handleScheduleChange(e.target.value)}
                        placeholder="每个工作日 08:00 / 0 8 * * 1-5"
                      />
                      <button
                        className="shell-button"
                        type="button"
                        onClick={() => setShowPresets(!showPresets)}
                        title="Presets"
                      >
                        <ChevronDown size={14} />
                      </button>
                    </div>
                    {showPresets && (
                      <div className="cron-preset-dropdown">
                        {CRON_PRESET_GROUPS.map((group) => (
                          <div key={group.category}>
                            <div className="cron-preset-group-head">{group.category}</div>
                            {group.presets.map((p) => (
                              <button
                                key={`${group.category}-${p.cron}-${p.label}`}
                                type="button"
                                className={`cron-preset-option${p.cron === draft.cron ? ' active' : ''}`}
                                onClick={() => applyPreset(p.cron, p.suggestedTimezone)}
                              >
                                <span>{p.label}</span>
                                <code>{p.cron}</code>
                              </button>
                            ))}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>

                  {/* Visual cron fields */}
                  <div className="cron-visual-fields">
                    {(['minute', 'hour', 'dayOfMonth', 'month', 'dayOfWeek'] as const).map((field) => {
                      const fields = parseCronFields(draft.cron);
                      const labels: Record<string, string> = { minute: '分', hour: '时', dayOfMonth: '日', month: '月', dayOfWeek: '周' };
                      const options: Record<string, string[]> = {
                        minute: ['*', '0', '5', '10', '15', '20', '30', '45', '*/5', '*/10', '*/15', '*/30'],
                        hour: ['*', '0', '1', '2', '4', '6', '8', '9', '10', '12', '14', '15', '16', '18', '20', '22', '*/2', '*/4', '*/6'],
                        dayOfMonth: ['*', '1', '15'],
                        month: ['*', '1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12'],
                        dayOfWeek: ['*', '0', '1', '2', '3', '4', '5', '6', '1-5', '0,6'],
                      };
                      const current = fields[field];
                      const opts = options[field] ?? ['*'];
                      const isCustom = !opts.includes(current);
                      return (
                        <div key={field} className="cron-visual-field">
                          <label>{labels[field]}</label>
                          <select
                            value={isCustom ? '__custom__' : current}
                            onChange={(e) => {
                              if (e.target.value !== '__custom__') handleFieldChange(field, e.target.value);
                            }}
                          >
                            {opts.map((o) => <option key={o} value={o}>{o}</option>)}
                            {isCustom && <option value="__custom__">{current}</option>}
                          </select>
                        </div>
                      );
                    })}
                  </div>

                  <span className="provider-field-hint">
                    输入中文自然语言或标准 cron 表达式，也可从预设中选择
                  </span>
                </div>

                {/* Timezone */}
                <div className="provider-field">
                  <span className="provider-field-label">时区</span>
                  <select
                    className="input"
                    value={draft.timezone ?? ''}
                    onChange={(e) => {
                      const tz = e.target.value || null;
                      setDraft((d) => ({ ...d, timezone: tz }));
                      setScheduleInput(cronToHuman(draft.cron, tz));
                    }}
                  >
                    {TIMEZONE_OPTIONS.map((o) => (
                      <option key={o.value ?? ''} value={o.value ?? ''}>{o.label}</option>
                    ))}
                  </select>
                  <span className="provider-field-hint">
                    选择交易时段预设时会自动设置对应时区
                  </span>
                </div>

                {/* System Prompt */}
                <div className="provider-field">
                  <span className="provider-field-label">System Prompt</span>
                  <textarea
                    className="input"
                    style={{ minHeight: 80, resize: 'vertical', padding: 10 }}
                    value={draft.systemPrompt}
                    onChange={(e) => setDraft((d) => ({ ...d, systemPrompt: e.target.value }))}
                    placeholder="Agent 的系统指令..."
                  />
                </div>

                {/* User Message */}
                <div className="provider-field">
                  <span className="provider-field-label">User Message</span>
                  <input
                    className="input"
                    value={draft.userMessage}
                    onChange={(e) => setDraft((d) => ({ ...d, userMessage: e.target.value }))}
                    placeholder="开始定时看盘分析"
                  />
                </div>

                {/* Model picker */}
                <div className="provider-field">
                  <CronModelPicker value={draft.model} onChange={(v) => setDraft((d) => ({ ...d, model: v }))} />
                </div>

                {/* Max Iterations */}
                <div className="provider-field">
                  <span className="provider-field-label">最大迭代次数 <em>optional</em></span>
                  <input
                    className="input"
                    type="number"
                    min={1}
                    value={draft.maxIterations ?? ''}
                    onChange={(e) => setDraft((d) => ({ ...d, maxIterations: e.target.value ? Number(e.target.value) : null }))}
                    placeholder="默认 10"
                  />
                  <span className="provider-field-hint">Agent 工具调用循环的最大轮数，留空使用默认值</span>
                </div>

                {/* Max Candles */}
                <div className="provider-field">
                  <span className="provider-field-label">最大 K 线数 <em>optional</em></span>
                  <input
                    className="input"
                    type="number"
                    min={1}
                    value={draft.maxCandles ?? ''}
                    onChange={(e) => setDraft((d) => ({ ...d, maxCandles: e.target.value ? Number(e.target.value) : null }))}
                    placeholder="默认跟随全局设置"
                  />
                  <span className="provider-field-hint">传给 LLM 的 OHLCV 数据条数上限</span>
                </div>

                {/* Use main system prompt toggle */}
                <div className="settings-toggle-row">
                  <div>
                    <strong>系统提示词</strong>
                    <small>使用主系统提示词（多方法论分析框架 + 交易执行权限）</small>
                  </div>
                  <label className="switch-row">
                    <input type="checkbox" checked={draft.useMainPrompt} onChange={() => setDraft((d) => ({ ...d, useMainPrompt: !d.useMainPrompt }))} />
                    <span className="switch-slider" />
                  </label>
                </div>

                {/* Trading tools toggle */}
                <div className="settings-toggle-row">
                  <div>
                    <strong>交易工具</strong>
                    <small>允许 Agent 执行下单、查看持仓等操作</small>
                  </div>
                  <label className="switch-row">
                    <input type="checkbox" checked={draft.tradingEnabled} onChange={() => setDraft((d) => ({ ...d, tradingEnabled: !d.tradingEnabled }))} />
                    <span className="switch-slider" />
                  </label>
                </div>
              </div>

              {/* Actions */}
              <div className="provider-connection-actions">
                <div className="settings-action-row">
                  <button
                    className="shell-button primary"
                    type="button"
                    disabled={saving}
                    onClick={handleSave}
                  >
                    <Save size={14} />
                    {creating ? '创建' : '保存'}
                  </button>
                  {!creating && selected && (
                    <button
                      className={`shell-button danger${deleteConfirm ? '' : ''}`}
                      type="button"
                      disabled={saving}
                      onClick={handleDelete}
                    >
                      <Trash2 size={14} />
                      {deleteConfirm ? '确认删除' : '删除'}
                    </button>
                  )}
                </div>
                {status && (
                  <span className="provider-connection-status">{status}</span>
                )}
              </div>
            </>
          )}
        </section>
      </div>
    </>
  );
}
