import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Brain,
  Check,
  ChevronDown,
  ChevronRight,
  File,
  Folder,
  Search,
  ArrowLeft,
  RefreshCw,
  Database,
  Cpu,
  Clock,
  Trash2,
} from 'lucide-react';
import { ProviderIcon } from '../ProviderIcon';
import type {
  AgentModelOption,
  MemoryBrowseListResult,
  MemoryBrowseReadResult,
  MemoryBrowseSearchResult,
  MemoryConfigUpdate,
  MemoryStatus,
} from '../../types';
import { AGENT_PROVIDER_OPTIONS } from '../../constants';
import { useAgentStore } from '../../stores/agentStore';
import { useMarketStore } from '../../stores/marketStore';
import {
  fetchMemoryStatus,
  fetchProviderModels,
  saveMemoryConfig,
  memoryList,
  memoryRead,
  memorySearch,
} from '../../api';

type BrowseMode = 'tree' | 'read' | 'search';

function MemoryModelPicker({
  label,
  value,
  disabled,
  onChange,
}: {
  label: string;
  value: string | null;
  disabled: boolean;
  onChange: (model: string | null) => void;
}) {
  const modelCache = useAgentStore((s) => s.modelCache);
  const agentConfig = useMarketStore((s) => s.state?.config.agent);
  const profiles = agentConfig?.providerProfiles ?? {};
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [localCache, setLocalCache] = useState<Record<string, AgentModelOption[]>>({});
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
        setSearch('');
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const enabledProviders = AGENT_PROVIDER_OPTIONS.filter((o) => profiles[o.provider]?.enabled);
    for (const opt of enabledProviders) {
      if (modelCache[opt.provider]?.length || localCache[opt.provider]?.length) continue;
      fetchProviderModels(opt.provider)
        .then((payload) => {
          const visible = payload.models.filter((m) => m.supportedInApi && m.visibility !== 'hide');
          useAgentStore.getState().setModelCache((prev) => ({ ...prev, [opt.provider]: visible }));
          setLocalCache((prev) => ({ ...prev, [opt.provider]: visible }));
        })
        .catch(() => {});
    }
  }, [open, profiles, modelCache, localCache]);

  const enabledProviders = AGENT_PROVIDER_OPTIONS.filter((o) => profiles[o.provider]?.enabled);
  const kw = search.trim().toLowerCase();

  const displayValue = value || 'Agent default';
  const providerForValue = value && value.includes(':') ? value.split(':')[0] : null;
  const modelSlugForValue = value && value.includes(':') ? value.split(':').slice(1).join(':') : value;

  return (
    <div className="memory-model-picker" ref={ref}>
      <span className="memory-model-picker-label">{label}</span>
      <button
        className="memory-model-trigger"
        type="button"
        disabled={disabled}
        onClick={() => setOpen(!open)}
      >
        {providerForValue ? (
          <span className="memory-model-provider-icon">
            <ProviderIcon provider={providerForValue} size={13} />
          </span>
        ) : (
          <span className="memory-model-provider-icon"><Cpu size={11} /></span>
        )}
        <span className="memory-model-trigger-text">{modelSlugForValue || displayValue}</span>
        <ChevronDown size={13} />
      </button>
      {open && (
        <div className="memory-model-dropdown">
          <div className="memory-model-dropdown-search">
            <Search size={13} />
            <input
              autoFocus
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search models..."
            />
          </div>
          <div className="memory-model-dropdown-list">
            <button
              className={`memory-model-option ${!value ? 'active' : ''}`}
              type="button"
              onClick={() => { onChange(null); setOpen(false); setSearch(''); }}
            >
              {!value && <Check size={12} />}
              <span>Agent default</span>
              <span className="memory-model-option-hint">inherit</span>
            </button>
            {enabledProviders.map((opt) => {
              const providerModels = (modelCache[opt.provider] ?? []).filter((m) =>
                !kw || m.slug.toLowerCase().includes(kw) || m.displayName.toLowerCase().includes(kw),
              );
              if (providerModels.length === 0) return null;
              return (
                <div key={opt.provider} className="memory-model-group">
                  <div className="memory-model-group-head">
                    <ProviderIcon provider={opt.provider} size={13} />
                    <span>{opt.label}</span>
                  </div>
                  {providerModels.map((m) => {
                    const fullSlug = `${opt.provider}:${m.slug}`;
                    const isActive = value === fullSlug || (value === m.slug && !value.includes(':'));
                    return (
                      <button
                        key={m.slug}
                        className={`memory-model-option ${isActive ? 'active' : ''}`}
                        type="button"
                        onClick={() => { onChange(fullSlug); setOpen(false); setSearch(''); }}
                      >
                        {isActive && <Check size={12} />}
                        <span>{m.displayName || m.slug}</span>
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

function StoragePathInput({
  value,
  disabled,
  onSave,
}: {
  value: string | null;
  disabled: boolean;
  onSave: (path: string | null) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value ?? '');

  useEffect(() => {
    setDraft(value ?? '');
  }, [value]);

  function commit() {
    const trimmed = draft.trim();
    onSave(trimmed || null);
    setEditing(false);
  }

  function cancel() {
    setDraft(value ?? '');
    setEditing(false);
  }

  return (
    <div className="memory-storage-path">
      <span className="memory-model-picker-label">Storage path</span>
      {editing ? (
        <div className="memory-storage-path-edit">
          <input
            autoFocus
            className="memory-storage-path-input"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commit();
              if (e.key === 'Escape') cancel();
            }}
            placeholder="~/.local/share/tradex/memories"
            disabled={disabled}
          />
          <button className="memory-browser-btn" type="button" onClick={commit} disabled={disabled}>
            Save
          </button>
          <button className="memory-browser-btn" type="button" onClick={cancel}>
            Cancel
          </button>
        </div>
      ) : (
        <button
          className="memory-storage-path-display"
          type="button"
          disabled={disabled}
          onClick={() => setEditing(true)}
        >
          <Database size={12} />
          <span className="memory-storage-path-value">
            {value || '~/.local/share/tradex/memories'}
          </span>
          {!value && <span className="memory-model-option-hint">default</span>}
        </button>
      )}
    </div>
  );
}

export function MemorySettingsPanel() {
  const state = useMarketStore((s) => s.state);
  const config = state?.config.memory;
  const [saving, setSaving] = useState(false);
  const [statusMsg, setStatusMsg] = useState('');
  const [memStatus, setMemStatus] = useState<MemoryStatus | null>(null);

  const [browseMode, setBrowseMode] = useState<BrowseMode>('tree');
  const [browsePath, setBrowsePath] = useState<string | null>(null);
  const [pathStack, setPathStack] = useState<string[]>([]);
  const [listing, setListing] = useState<MemoryBrowseListResult | null>(null);
  const [fileContent, setFileContent] = useState<MemoryBrowseReadResult | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<MemoryBrowseSearchResult | null>(null);
  const [browseLoading, setBrowseLoading] = useState(false);
  const [browseError, setBrowseError] = useState<string | null>(null);

  useEffect(() => {
    fetchMemoryStatus().then(setMemStatus).catch(() => {});
  }, [config?.enabled]);

  const loadDir = useCallback(async (path: string | null) => {
    setBrowseLoading(true);
    setBrowseError(null);
    try {
      const result = await memoryList(path ?? undefined);
      setListing(result);
      setBrowsePath(path);
      setBrowseMode('tree');
      setFileContent(null);
      setSearchResults(null);
    } catch (e) {
      setBrowseError(e instanceof Error ? e.message : 'Failed to list');
    } finally {
      setBrowseLoading(false);
    }
  }, []);

  const openFile = useCallback(async (path: string) => {
    setBrowseLoading(true);
    setBrowseError(null);
    try {
      const result = await memoryRead(path);
      setFileContent(result);
      setBrowseMode('read');
    } catch (e) {
      setBrowseError(e instanceof Error ? e.message : 'Failed to read');
    } finally {
      setBrowseLoading(false);
    }
  }, []);

  const runSearch = useCallback(async () => {
    const terms = searchQuery.trim();
    if (!terms) return;
    setBrowseLoading(true);
    setBrowseError(null);
    try {
      const queries = terms.split(/\s+/).filter(Boolean);
      const result = await memorySearch(queries);
      setSearchResults(result);
      setBrowseMode('search');
      setFileContent(null);
    } catch (e) {
      setBrowseError(e instanceof Error ? e.message : 'Search failed');
    } finally {
      setBrowseLoading(false);
    }
  }, [searchQuery]);

  const navigateInto = (path: string) => {
    setPathStack((prev) => [...prev, browsePath ?? '']);
    loadDir(path);
  };

  const navigateUp = () => {
    const prev = pathStack[pathStack.length - 1];
    setPathStack((s) => s.slice(0, -1));
    loadDir(prev || null);
  };

  useEffect(() => {
    loadDir(null);
  }, [loadDir]);

  async function persistConfig(update: MemoryConfigUpdate) {
    setSaving(true);
    setStatusMsg('Saving...');
    try {
      const nextState = await saveMemoryConfig(update);
      useMarketStore.getState().setState(nextState);
      setStatusMsg('Saved.');
      fetchMemoryStatus().then(setMemStatus).catch(() => {});
    } catch (error) {
      setStatusMsg(error instanceof Error ? error.message : 'Save failed.');
    } finally {
      setSaving(false);
    }
  }

  if (!config) {
    return <div className="empty-state lg">Loading settings...</div>;
  }

  return (
    <>
      <header className="settings-stage-head">
        <div>
          <div className="eyebrow">Configuration</div>
          <h2>Memory</h2>
        </div>
        <div className="settings-stage-actions">
          <span className={`badge${config.enabled ? ' success' : ''}`}>
            {config.enabled ? 'Active' : 'Disabled'}
          </span>
        </div>
      </header>

      <div className="provider-layout">
        {/* Left: Config panel */}
        <section className="provider-catalog">
          <div className="provider-section-head">
            <strong>Pipeline</strong>
            {memStatus && (
              <span className="badge">{memStatus.pipelineRunning ? 'Running' : 'Idle'}</span>
            )}
          </div>

          <label className="settings-toggle-row">
            <div>
              <strong>Enable memory system</strong>
              <small>Controls the [memory] block in watchlist.toml.</small>
            </div>
            <button
              className={`settings-toggle ${config.enabled ? 'on' : ''}`}
              type="button"
              disabled={saving}
              onClick={() => persistConfig({ enabled: !config.enabled })}
              aria-pressed={config.enabled}
            >
              <span />
            </button>
          </label>

          <label className="settings-toggle-row">
            <div>
              <strong>Use memories (read)</strong>
              <small>Inject memory_summary.md into agent prompts.</small>
            </div>
            <button
              className={`settings-toggle ${config.useMemories ? 'on' : ''}`}
              type="button"
              disabled={saving || !config.enabled}
              onClick={() => persistConfig({ useMemories: !config.useMemories })}
              aria-pressed={config.useMemories}
            >
              <span />
            </button>
          </label>

          <label className="settings-toggle-row">
            <div>
              <strong>Generate memories (write)</strong>
              <small>Run Phase 1 extraction + Phase 2 consolidation.</small>
            </div>
            <button
              className={`settings-toggle ${config.generateMemories ? 'on' : ''}`}
              type="button"
              disabled={saving || !config.enabled}
              onClick={() => persistConfig({ generateMemories: !config.generateMemories })}
              aria-pressed={config.generateMemories}
            >
              <span />
            </button>
          </label>

          <StoragePathInput
            value={config.storagePath}
            disabled={saving}
            onSave={(path) => persistConfig({ storagePath: path })}
          />

          <div className="memory-model-pickers">
            <MemoryModelPicker
              label="Extract model (Phase 1)"
              value={config.extractModel}
              disabled={saving}
              onChange={(model) => persistConfig({ extractModel: model })}
            />
            <MemoryModelPicker
              label="Consolidation model (Phase 2)"
              value={config.consolidationModel}
              disabled={saving}
              onChange={(model) => persistConfig({ consolidationModel: model })}
            />
          </div>

          <div className="settings-readonly-grid" style={{ marginTop: 12 }}>
            <div>
              <span className="panel-label"><Database size={12} /> Max raw memories</span>
              <strong>{config.maxRawMemories}</strong>
            </div>
            <div>
              <span className="panel-label"><Clock size={12} /> Max unused days</span>
              <strong>{config.maxUnusedDays}d</strong>
            </div>
            <div>
              <span className="panel-label"><Clock size={12} /> Max source age</span>
              <strong>{config.maxSourceAgeDays}d</strong>
            </div>
            <div>
              <span className="panel-label"><Clock size={12} /> Min session idle</span>
              <strong>{config.minSessionIdleHours}h</strong>
            </div>
            <div>
              <span className="panel-label"><Trash2 size={12} /> Extension retention</span>
              <strong>{config.extensionRetentionDays}d</strong>
            </div>
            <div>
              <span className="panel-label"><Database size={12} /> Scan limit</span>
              <strong>{config.maxRolloutsPerStartup}</strong>
            </div>
          </div>

          {memStatus && (
            <div className="settings-readonly-grid" style={{ marginTop: 12 }}>
              <div>
                <span className="panel-label">Sources</span>
                <strong>{memStatus.sourceCount}</strong>
              </div>
              <div>
                <span className="panel-label">Outputs</span>
                <strong>{memStatus.outputCount}</strong>
              </div>
              <div>
                <span className="panel-label">Phase 2</span>
                <strong>{memStatus.phase2Status === 'unknown' ? (config.enabled ? 'Initializing' : 'Not active') : memStatus.phase2Status}</strong>
              </div>
            </div>
          )}
          {statusMsg && <div className="provider-status-bar">{statusMsg}</div>}
        </section>

        {/* Right: Memory browser */}
        <section className="provider-detail memory-browser">
          <div className="provider-section-head">
            <strong>
              <Brain size={16} style={{ verticalAlign: -2 }} /> Memory Browser
            </strong>
            <button
              className="memory-browser-btn"
              type="button"
              onClick={() => {
                setBrowseMode('tree');
                setFileContent(null);
                setSearchResults(null);
                loadDir(null);
                setPathStack([]);
              }}
              title="Reset to root"
            >
              <RefreshCw size={14} />
            </button>
          </div>

          {/* Search bar */}
          <div className="memory-search-bar">
            <Search size={14} className="memory-search-icon" />
            <input
              type="text"
              placeholder="Search memories... (space-separated keywords)"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && runSearch()}
              className="memory-search-input"
            />
            <button
              className="memory-browser-btn"
              type="button"
              disabled={browseLoading || !searchQuery.trim()}
              onClick={runSearch}
            >
              Search
            </button>
          </div>

          {browseError && (
            <div className="memory-error">{browseError}</div>
          )}

          {browseLoading && (
            <div className="memory-loading">Loading...</div>
          )}

          {/* Directory listing */}
          {browseMode === 'tree' && listing && !browseLoading && (
            <div className="memory-file-list">
              {browsePath && (
                <button className="memory-file-item" type="button" onClick={navigateUp}>
                  <ArrowLeft size={14} />
                  <span className="memory-file-name">..</span>
                </button>
              )}
              {listing.entries.length === 0 && (
                <div className="memory-empty">No memory files yet. Enable the pipeline to start generating.</div>
              )}
              {listing.entries.map((entry) => (
                <button
                  key={entry.path}
                  className="memory-file-item"
                  type="button"
                  onClick={() => {
                    if (entry.entryType === 'directory') {
                      navigateInto(entry.path);
                    } else {
                      openFile(entry.path);
                    }
                  }}
                >
                  {entry.entryType === 'directory' ? (
                    <Folder size={14} className="memory-icon-dir" />
                  ) : (
                    <File size={14} className="memory-icon-file" />
                  )}
                  <span className="memory-file-name">
                    {entry.path.split('/').pop()}
                  </span>
                  {entry.entryType === 'directory' && <ChevronRight size={14} className="memory-chevron" />}
                </button>
              ))}
            </div>
          )}

          {/* File reader */}
          {browseMode === 'read' && fileContent && !browseLoading && (
            <div className="memory-file-reader">
              <div className="memory-file-reader-head">
                <button className="memory-browser-btn" type="button" onClick={() => {
                  setBrowseMode('tree');
                  setFileContent(null);
                }}>
                  <ArrowLeft size={14} /> Back
                </button>
                <span className="memory-file-reader-path">{fileContent.path}</span>
                {fileContent.truncated && <span className="badge">truncated</span>}
              </div>
              <pre className="memory-file-content">{fileContent.content}</pre>
            </div>
          )}

          {/* Search results */}
          {browseMode === 'search' && searchResults && !browseLoading && (
            <div className="memory-search-results">
              <div className="memory-search-results-head">
                <button className="memory-browser-btn" type="button" onClick={() => {
                  setBrowseMode('tree');
                  setSearchResults(null);
                }}>
                  <ArrowLeft size={14} /> Back
                </button>
                <span>
                  {searchResults.matches.length} match{searchResults.matches.length !== 1 ? 'es' : ''} for
                  {' '}<strong>{searchResults.queries.join(', ')}</strong>
                </span>
              </div>
              {searchResults.matches.length === 0 && (
                <div className="memory-empty">No matches found.</div>
              )}
              {searchResults.matches.map((match, i) => (
                <button
                  key={`${match.path}:${match.matchLineNumber}:${i}`}
                  className="memory-search-hit"
                  type="button"
                  onClick={() => openFile(match.path)}
                >
                  <div className="memory-search-hit-head">
                    <File size={12} />
                    <span>{match.path}</span>
                    <span className="memory-line-badge">L{match.matchLineNumber}</span>
                  </div>
                  <pre className="memory-search-hit-body">{match.content}</pre>
                </button>
              ))}
            </div>
          )}
        </section>
      </div>
    </>
  );
}
