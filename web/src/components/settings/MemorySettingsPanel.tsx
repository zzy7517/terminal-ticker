import { useCallback, useEffect, useState } from 'react';
import {
  Brain,
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
import type {
  MemoryBrowseListResult,
  MemoryBrowseReadResult,
  MemoryBrowseSearchResult,
  MemoryConfigUpdate,
  MemoryStatus,
} from '../../types';
import { useMarketStore } from '../../stores/marketStore';
import {
  fetchMemoryStatus,
  saveMemoryConfig,
  memoryList,
  memoryRead,
  memorySearch,
} from '../../api';

type BrowseMode = 'tree' | 'read' | 'search';

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

          <div className="settings-readonly-grid" style={{ marginTop: 12 }}>
            <div>
              <span className="panel-label"><Cpu size={12} /> Extract model</span>
              <strong>{config.extractModel || 'Agent default'}</strong>
            </div>
            <div>
              <span className="panel-label"><Cpu size={12} /> Consolidation model</span>
              <strong>{config.consolidationModel || 'Agent default'}</strong>
            </div>
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
                <strong>{memStatus.phase2Status}</strong>
              </div>
            </div>
          )}

          <div className="settings-hint" style={{ marginTop: 8 }}>
            Models and numeric limits are read from watchlist.toml [memory] section. Edit and
            restart to change.
          </div>
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
