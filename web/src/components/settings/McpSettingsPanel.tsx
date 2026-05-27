import { useEffect, useState } from 'react';
import {
  ChevronDown,
  ChevronRight,
  Database,
  FileText,
  Loader2,
  Plug,
  Plus,
  RefreshCw,
  Save,
  Terminal,
  Trash2,
  Unplug,
  Wrench,
  Globe,
  Pencil,
  X,
} from 'lucide-react';
import type {
  McpServerInfo,
  McpStatusResponse,
  McpToolInfo,
  McpServerEntry,
  McpResourceInfo,
  McpResourceTemplateInfo,
  McpResourceContent,
} from '../../types';
import {
  fetchMcpStatus,
  connectMcpServer,
  disconnectMcpServer,
  fetchMcpServerTools,
  fetchMcpServerResources,
  fetchMcpServerResourceTemplates,
  readMcpResource,
  updateMcpSettings,
  addMcpServer,
  updateMcpServer,
  deleteMcpServer,
  saveJin10Config,
  fetchJin10AvailableCodes,
} from '../../api';
import { useMarketStore } from '../../stores/marketStore';
import './McpSettingsPanel.css';

type ServerFormMode = 'view' | 'edit' | 'create';
type DetailTab = 'overview' | 'tools' | 'resources' | 'jin10-config';

function statusBadge(status: McpServerInfo['status']) {
  switch (status) {
    case 'connected': return <span className="badge success">Connected</span>;
    case 'connecting': return <span className="badge warning">Connecting</span>;
    case 'failed': return <span className="badge danger">Failed</span>;
    default: return <span className="badge">Idle</span>;
  }
}

export function McpSettingsPanel() {
  const [mcpStatus, setMcpStatus] = useState<McpStatusResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<string | null>(null);
  const [detailTab, setDetailTab] = useState<DetailTab>('overview');
  const [tools, setTools] = useState<McpToolInfo[]>([]);
  const [toolsLoading, setToolsLoading] = useState(false);
  const [toolsExpanded, setToolsExpanded] = useState(false);
  const [resources, setResources] = useState<McpResourceInfo[]>([]);
  const [resourceTemplates, setResourceTemplates] = useState<McpResourceTemplateInfo[]>([]);
  const [resourcesLoading, setResourcesLoading] = useState(false);
  const [readResult, setReadResult] = useState<{ uri: string; contents: McpResourceContent[] } | null>(null);
  const [readLoading, setReadLoading] = useState(false);
  const [status, setStatus] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);

  const [formMode, setFormMode] = useState<ServerFormMode>('view');
  const [formName, setFormName] = useState('');
  const [formCommand, setFormCommand] = useState('');
  const [formArgs, setFormArgs] = useState('');
  const [formUrl, setFormUrl] = useState('');
  const [formCwd, setFormCwd] = useState('');
  const [formEnv, setFormEnv] = useState('');
  const [formIdleTimeout, setFormIdleTimeout] = useState('');

  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsPrefix, setSettingsPrefix] = useState<'server' | 'none' | 'short'>('server');
  const [settingsIdleTimeout, setSettingsIdleTimeout] = useState('10');
  const [settingsSaving, setSettingsSaving] = useState(false);

  const [deleteConfirm, setDeleteConfirm] = useState(false);

  // ─── Jin10-specific state ──────────────────────────────────────────────────
  const jin10Config = useMarketStore((s) => s.state?.config?.jin10);
  const [jin10Token, setJin10Token] = useState('');
  const [jin10TokenSaving, setJin10TokenSaving] = useState(false);
  const [jin10AvailCodes, setJin10AvailCodes] = useState<Array<{ code: string; name: string }>>([]);
  const [jin10AddingCode, setJin10AddingCode] = useState('');
  const [jin10CodeSaving, setJin10CodeSaving] = useState(false);

  // Sync token from config
  useEffect(() => {
    if (jin10Config?.tokenConfigured && !jin10Token) {
      setJin10Token('••••••••'); // masked
    }
  }, [jin10Config?.tokenConfigured]);

  // Load available codes when jin10 is selected
  useEffect(() => {
    if (selected === 'jin10' && jin10AvailCodes.length === 0) {
      fetchJin10AvailableCodes().then((res) => {
        if (res.codes.length > 0) setJin10AvailCodes(res.codes);
      }).catch(() => {});
    }
  }, [selected]);

  async function handleJin10TokenSave() {
    if (jin10Token === '••••••••' || !jin10Token.trim()) return;
    setJin10TokenSaving(true);
    try {
      const nextState = await saveJin10Config({ token: jin10Token.trim() });
      useMarketStore.getState().setState(nextState);
      setStatus('Jin10 Token 已保存');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Token save failed');
    } finally {
      setJin10TokenSaving(false);
    }
  }

  async function handleJin10Toggle(field: 'enabled' | 'flash_enabled' | 'calendar_enabled' | 'quotes_enabled', value: boolean) {
    try {
      const nextState = await saveJin10Config({ [field]: value });
      useMarketStore.getState().setState(nextState);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Toggle failed');
    }
  }

  async function handleJin10AddCode(code: string) {
    const normalized = code.trim().toUpperCase();
    if (!normalized) return;
    const current = jin10Config?.quotesCodes ?? [];
    if (current.includes(normalized)) return;
    setJin10CodeSaving(true);
    setJin10AddingCode('');
    try {
      const nextState = await saveJin10Config({ quotes_codes: [...current, normalized] });
      useMarketStore.getState().setState(nextState);
    } catch { /* ignore */ }
    finally { setJin10CodeSaving(false); }
  }

  async function handleJin10RemoveCode(code: string) {
    const current = jin10Config?.quotesCodes ?? [];
    setJin10CodeSaving(true);
    try {
      const nextState = await saveJin10Config({ quotes_codes: current.filter((c) => c !== code) });
      useMarketStore.getState().setState(nextState);
    } catch { /* ignore */ }
    finally { setJin10CodeSaving(false); }
  }

  useEffect(() => { loadStatus(); }, []);

  async function loadStatus() {
    setLoading(true);
    try {
      const data = await fetchMcpStatus();
      setMcpStatus(data);
      if (data.settings) {
        setSettingsPrefix(data.settings.toolPrefix ?? 'server');
        setSettingsIdleTimeout(String(data.settings.idleTimeout ?? 10));

      }
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load MCP status');
    } finally {
      setLoading(false);
    }
  }

  function selectServer(name: string) {
    setSelected(name);
    setFormMode('view');
    setDetailTab(name === 'jin10' ? 'jin10-config' : 'overview');
    setTools([]); setToolsExpanded(false);
    setResources([]); setResourceTemplates([]); setReadResult(null);
    setDeleteConfirm(false);
    setStatus('');
    setError(null);
  }

  function startCreate() {
    setSelected(null);
    setFormMode('create');
    setFormName(''); setFormCommand(''); setFormArgs(''); setFormUrl('');
    setFormCwd(''); setFormEnv(''); setFormIdleTimeout('');
    setDeleteConfirm(false); setTools([]); setResources([]); setResourceTemplates([]);
    setReadResult(null); setStatus(''); setError(null);
  }

  function startEdit() {
    const server = mcpStatus?.servers.find((s) => s.name === selected);
    if (!server) return;
    setFormMode('edit');
    setFormName(server.name);
    setFormCommand(server.command ?? '');
    setFormArgs(server.args.join(' '));
    setFormUrl(server.url ?? '');
    setFormCwd(server.cwd ?? '');
    setFormEnv(server.env.join(', '));
    setFormIdleTimeout(server.idleTimeout != null ? String(server.idleTimeout) : '');
    setDeleteConfirm(false);
  }

  async function handleConnect(name: string) {
    setConnecting(true); setError(null);
    try {
      const result = await connectMcpServer(name);
      setStatus(`Connected — ${result.toolCount ?? 0} tools available`);
      await loadStatus();
    } catch (e) { setError(e instanceof Error ? e.message : 'Connect failed'); }
    finally { setConnecting(false); }
  }

  async function handleDisconnect(name: string) {
    setConnecting(true); setError(null);
    try {
      await disconnectMcpServer(name);
      setStatus('Disconnected'); setTools([]); setResources([]); setResourceTemplates([]); setReadResult(null);
      await loadStatus();
    } catch (e) { setError(e instanceof Error ? e.message : 'Disconnect failed'); }
    finally { setConnecting(false); }
  }

  async function handleLoadResources(name: string) {
    setResourcesLoading(true);
    try {
      const [resData, tmplData] = await Promise.all([
        fetchMcpServerResources(name),
        fetchMcpServerResourceTemplates(name),
      ]);
      setResources(resData.resources);
      setResourceTemplates(tmplData.resourceTemplates);
    } catch (e) { setError(e instanceof Error ? e.message : 'Failed to load resources'); }
    finally { setResourcesLoading(false); }
  }

  async function handleReadResource(serverName: string, uri: string) {
    setReadLoading(true); setReadResult(null);
    try {
      const data = await readMcpResource(serverName, uri);
      setReadResult({ uri, contents: data.contents });
    } catch (e) { setError(e instanceof Error ? e.message : 'Failed to read resource'); }
    finally { setReadLoading(false); }
  }

  function switchDetailTab(tab: DetailTab) {
    setDetailTab(tab); setReadResult(null);
    if (!selected) return;
    const server = mcpStatus?.servers.find((s) => s.name === selected);
    if (!server || server.status !== 'connected') return;
    if (tab === 'tools' && tools.length === 0) handleLoadTools(selected);
    if (tab === 'resources' && resources.length === 0) handleLoadResources(selected);
  }

  async function handleLoadTools(name: string) {
    setToolsLoading(true);
    try {
      const data = await fetchMcpServerTools(name);
      setTools(data.tools); setToolsExpanded(true);
    } catch (e) { setError(e instanceof Error ? e.message : 'Failed to load tools'); }
    finally { setToolsLoading(false); }
  }

  function buildEntryFromForm(): McpServerEntry {
    const entry: McpServerEntry = {};
    if (formCommand.trim()) entry.command = formCommand.trim();
    if (formArgs.trim()) entry.args = formArgs.trim().split(/\s+/);
    if (formUrl.trim()) entry.url = formUrl.trim();
    if (formCwd.trim()) entry.cwd = formCwd.trim();
    if (formEnv.trim()) {
      const envObj: Record<string, string> = {};
      formEnv.split(',').forEach((pair) => {
        const [k, ...v] = pair.trim().split('=');
        if (k) envObj[k.trim()] = v.join('=').trim();
      });
      if (Object.keys(envObj).length > 0) entry.env = envObj;
    }
    if (formIdleTimeout.trim()) entry.idleTimeout = Number(formIdleTimeout);
    return entry;
  }

  async function handleSaveServer() {
    setError(null);
    try {
      if (formMode === 'create') {
        if (!formName.trim()) { setError('Server name is required'); return; }
        if (!formCommand.trim() && !formUrl.trim()) { setError('Command or URL is required'); return; }
        await addMcpServer(formName.trim(), buildEntryFromForm());
        setStatus('Server added');
      } else if (formMode === 'edit' && selected) {
        await updateMcpServer(selected, buildEntryFromForm());
        setStatus('Server updated');
      }
      await loadStatus();
      if (formMode === 'create') setSelected(formName.trim());
      setFormMode('view');
    } catch (e) { setError(e instanceof Error ? e.message : 'Save failed'); }
  }

  async function handleDelete() {
    if (!selected) return;
    if (!deleteConfirm) { setDeleteConfirm(true); return; }
    try {
      await deleteMcpServer(selected);
      setSelected(null); setFormMode('view'); setDeleteConfirm(false);
      setStatus('Server deleted'); await loadStatus();
    } catch (e) { setError(e instanceof Error ? e.message : 'Delete failed'); }
  }

  async function handleSaveSettings() {
    setSettingsSaving(true);
    try {
      await updateMcpSettings({
        toolPrefix: settingsPrefix,
        idleTimeout: Number(settingsIdleTimeout) || 10,
      });
      setStatus('Settings saved'); await loadStatus();
    } catch (e) { setError(e instanceof Error ? e.message : 'Save settings failed'); }
    finally { setSettingsSaving(false); }
  }

  const servers = mcpStatus?.servers ?? [];
  const activeServer = selected ? servers.find((s) => s.name === selected) : null;
  const showEditor = formMode === 'create' || formMode === 'edit' || activeServer;

  // ─── Render ────────────────────────────────────────────────────────────────

  const renderServerForm = () => (
    <>
      <div className="provider-section-head">
        <strong>{formMode === 'create' ? 'New Server' : `Edit: ${selected}`}</strong>
      </div>

      {error && <div className="cron-error-banner"><span>{error}</span><button type="button" onClick={() => setError(null)}>dismiss</button></div>}

      <div className="provider-connection-form">
        <div className="provider-field">
          <span className="provider-field-label">Server Name</span>
          <input className="input" value={formName} onChange={(e) => setFormName(e.target.value)}
            placeholder="e.g. filesystem" disabled={formMode === 'edit'} />
        </div>

        <div className="provider-field">
          <span className="provider-field-label">Command <em>(stdio)</em></span>
          <input className="input mono" value={formCommand} onChange={(e) => setFormCommand(e.target.value)}
            placeholder="npx -y @modelcontextprotocol/server-filesystem" spellCheck={false} />
        </div>

        <div className="provider-field">
          <span className="provider-field-label">Arguments</span>
          <input className="input mono" value={formArgs} onChange={(e) => setFormArgs(e.target.value)}
            placeholder="/path/to/allowed/dir" spellCheck={false} />
          <span className="provider-field-hint">Space-separated command arguments</span>
        </div>

        <div className="provider-field">
          <span className="provider-field-label">URL <em>(HTTP/SSE)</em></span>
          <input className="input mono" type="url" value={formUrl} onChange={(e) => setFormUrl(e.target.value)}
            placeholder="http://localhost:3001/mcp" spellCheck={false} />
          <span className="provider-field-hint">For HTTP-based MCP servers. Leave empty for stdio.</span>
        </div>

        <div className="provider-field">
          <span className="provider-field-label">Working Directory <em>optional</em></span>
          <input className="input mono" value={formCwd} onChange={(e) => setFormCwd(e.target.value)}
            placeholder="/path/to/cwd" spellCheck={false} />
        </div>

        <div className="provider-field">
          <span className="provider-field-label">Environment Variables <em>optional</em></span>
          <input className="input mono" value={formEnv} onChange={(e) => setFormEnv(e.target.value)}
            placeholder="KEY=value, ANOTHER=val" spellCheck={false} />
          <span className="provider-field-hint">Comma-separated KEY=value pairs</span>
        </div>

        <div className="provider-field">
          <span className="provider-field-label">Idle Timeout (minutes) <em>optional</em></span>
          <input className="input" type="number" min={0} value={formIdleTimeout}
            onChange={(e) => setFormIdleTimeout(e.target.value)} placeholder="inherit global" />
        </div>
      </div>

      <div className="provider-connection-actions">
        <div className="settings-action-row">
          <button className="shell-button primary" type="button" onClick={handleSaveServer}>
            <Save size={14} /> {formMode === 'create' ? 'Create' : 'Save'}
          </button>
          <button className="shell-button muted" type="button" onClick={() => setFormMode('view')}>
            Cancel
          </button>
          {formMode === 'edit' && selected && (
            <button className="shell-button danger" type="button" onClick={handleDelete}>
              <Trash2 size={14} /> {deleteConfirm ? 'Confirm Delete' : 'Delete'}
            </button>
          )}
        </div>
      </div>
    </>
  );

  const renderJin10Config = () => {
    const codes = jin10Config?.quotesCodes ?? [];
    const codeNameMap = new Map(jin10AvailCodes.map((item) => [item.code, item.name]));
    const suggestions = jin10AvailCodes.filter((item) => !codes.includes(item.code));
    return (
      <div className="jin10-mcp-config">
        <div className="provider-section-head">
          <strong>Jin10 数据配置</strong>
        </div>

        {/* Token */}
        <div className="jin10-config-section">
          <div className="provider-field">
            <span className="provider-field-label">API Token</span>
            <div className="jin10-token-row">
              <input
                className="input mono"
                type="password"
                value={jin10Token}
                onChange={(e) => setJin10Token(e.target.value)}
                onFocus={() => { if (jin10Token === '\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022') setJin10Token(''); }}
                placeholder="sk-xxxxxxxx"
                spellCheck={false}
              />
              <button
                className="shell-button primary sm"
                type="button"
                onClick={handleJin10TokenSave}
                disabled={jin10TokenSaving || jin10Token === '\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022' || !jin10Token.trim()}
              >
                <Save size={13} /> 保存
              </button>
            </div>
            <span className="provider-field-hint">
              从 <a href="https://mcp.jin10.com/app/" target="_blank" rel="noreferrer">mcp.jin10.com</a> 获取 Token
            </span>
          </div>
        </div>

        {/* Module toggles */}
        <div className="jin10-config-section">
          <div className="provider-section-head"><strong>模块开关</strong></div>
          <div className="settings-toggle-row">
            <div><strong>总开关</strong><small>启用/禁用所有 Jin10 数据</small></div>
            <label className="switch-row">
              <input type="checkbox" checked={!!jin10Config?.enabled} onChange={() => handleJin10Toggle('enabled', !jin10Config?.enabled)} />
              <span className="switch-slider" />
            </label>
          </div>
          <div className="settings-toggle-row">
            <div><strong>快讯 (Flash)</strong><small>实时财经快讯推送到 News</small></div>
            <label className="switch-row">
              <input type="checkbox" checked={!!jin10Config?.flashEnabled} onChange={() => handleJin10Toggle('flash_enabled', !jin10Config?.flashEnabled)} />
              <span className="switch-slider" />
            </label>
          </div>
          <div className="settings-toggle-row">
            <div><strong>财经日历 (Calendar)</strong><small>今日经济事件与数据发布</small></div>
            <label className="switch-row">
              <input type="checkbox" checked={!!jin10Config?.calendarEnabled} onChange={() => handleJin10Toggle('calendar_enabled', !jin10Config?.calendarEnabled)} />
              <span className="switch-slider" />
            </label>
          </div>
          <div className="settings-toggle-row">
            <div><strong>行情 (Quotes)</strong><small>商品/外汇/指数参考报价</small></div>
            <label className="switch-row">
              <input type="checkbox" checked={!!jin10Config?.quotesEnabled} onChange={() => handleJin10Toggle('quotes_enabled', !jin10Config?.quotesEnabled)} />
              <span className="switch-slider" />
            </label>
          </div>
        </div>

        {/* Quotes codes */}
        {jin10Config?.quotesEnabled && (
          <div className="jin10-config-section">
            <div className="provider-section-head"><strong>行情品种</strong></div>
            <div className="jin10-codes-list">
              {codes.map((code) => (
                <span key={code} className="jin10-code-chip">
                  <span className="jin10-code-chip__label">{codeNameMap.get(code) || code}</span>
                  <button
                    className="jin10-code-chip__remove"
                    type="button"
                    onClick={() => handleJin10RemoveCode(code)}
                    disabled={jin10CodeSaving}
                    title="移除"
                  ><X size={11} /></button>
                </span>
              ))}
            </div>
            <div className="jin10-codes-add-row">
              <input
                className="input sm mono"
                value={jin10AddingCode}
                onChange={(e) => setJin10AddingCode(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); handleJin10AddCode(jin10AddingCode); } }}
                placeholder="输入品种代码回车添加"
                spellCheck={false}
                disabled={jin10CodeSaving}
              />
            </div>
            {suggestions.length > 0 && (
              <div className="jin10-codes-suggestions">
                <span className="jin10-codes-suggestions__label">可选品种：</span>
                <div className="jin10-codes-suggestions__list">
                  {suggestions
                    .filter((item) => {
                      if (!jin10AddingCode) return true;
                      const q = jin10AddingCode.toUpperCase();
                      return item.code.includes(q) || item.name.includes(jin10AddingCode);
                    })
                    .map((item) => (
                      <button
                        key={item.code}
                        type="button"
                        className="jin10-suggestion-chip"
                        onClick={() => handleJin10AddCode(item.code)}
                        disabled={jin10CodeSaving}
                        title={item.code}
                      >{item.name}</button>
                    ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    );
  };

  const renderServerView = () => {
    if (!activeServer) return null;
    return (
      <>
        <div className="provider-hero">
          <div className="provider-hero-title">
            <h3>{activeServer.name}</h3>
            {statusBadge(activeServer.status)}
          </div>
          <p>
            {activeServer.type === 'http' ? (
              <><Globe size={13} /> HTTP: <code>{activeServer.url}</code></>
            ) : (
              <><Terminal size={13} /> stdio: <code>{activeServer.command} {activeServer.args.join(' ')}</code></>
            )}
          </p>
        </div>

        {error && <div className="cron-error-banner"><span>{error}</span><button type="button" onClick={() => setError(null)}>dismiss</button></div>}

        {/* Connection actions */}
        <div className="mcp-server-actions">
          {activeServer.status !== 'connected' ? (
            <button className="shell-button primary" type="button" onClick={() => handleConnect(activeServer.name)} disabled={connecting}>
              {connecting ? <Loader2 className="spin" size={14} /> : <Plug size={14} />}
              Connect
            </button>
          ) : (
            <button className="shell-button muted" type="button" onClick={() => handleDisconnect(activeServer.name)} disabled={connecting}>
              {connecting ? <Loader2 className="spin" size={14} /> : <Unplug size={14} />}
              Disconnect
            </button>
          )}
          <button className="shell-button muted" type="button" onClick={startEdit}>
            <Pencil size={14} /> Edit
          </button>
        </div>

        {/* Server info */}
        <div className="mcp-server-info">
          <div className="mcp-info-grid">
            <div className="mcp-info-item">
              <span className="mcp-info-label">Type</span>
              <span className="mcp-info-value">{activeServer.type}</span>
            </div>

            <div className="mcp-info-item">
              <span className="mcp-info-label">Tools</span>
              <span className="mcp-info-value">{activeServer.toolCount}</span>
            </div>
            {activeServer.cwd && (
              <div className="mcp-info-item">
                <span className="mcp-info-label">CWD</span>
                <span className="mcp-info-value mono">{activeServer.cwd}</span>
              </div>
            )}
            {activeServer.env.length > 0 && (
              <div className="mcp-info-item">
                <span className="mcp-info-label">Env</span>
                <span className="mcp-info-value mono">{activeServer.env.join(', ')}</span>
              </div>
            )}
          </div>
        </div>

        {/* Tab navigation */}
        <div className="mcp-tabs">
          {selected === 'jin10' && (
            <button type="button" className={`mcp-tab${detailTab === 'jin10-config' ? ' active' : ''}`} onClick={() => setDetailTab('jin10-config')}>
              ⚙️ 配置
            </button>
          )}
          <button type="button" className={`mcp-tab${detailTab === 'overview' ? ' active' : ''}`} onClick={() => switchDetailTab('overview')}>
            Info
          </button>
          <button type="button" className={`mcp-tab${detailTab === 'tools' ? ' active' : ''}`} onClick={() => switchDetailTab('tools')}>
            <Wrench size={13} /> Tools {activeServer?.toolCount ? `(${activeServer.toolCount})` : ''}
          </button>
          <button type="button" className={`mcp-tab${detailTab === 'resources' ? ' active' : ''}`} onClick={() => switchDetailTab('resources')}>
            <Database size={13} /> Resources
          </button>
        </div>

        {/* Tab: Jin10 Config */}
        {detailTab === 'jin10-config' && renderJin10Config()}

        {/* Tab: Tools */}
        {detailTab === 'tools' && (
          <div className="mcp-tab-content">
            {toolsLoading && <div className="empty-state sm"><Loader2 className="spin" size={16} /> Loading tools...</div>}
            {!toolsLoading && tools.length === 0 && activeServer?.status === 'connected' && (
              <div className="empty-state sm">No tools discovered. <button className="link-btn" type="button" onClick={() => selected && handleLoadTools(selected)}>Refresh</button></div>
            )}
            {!toolsLoading && tools.length === 0 && activeServer?.status !== 'connected' && (
              <div className="empty-state sm">Connect server to discover tools.</div>
            )}
            {tools.length > 0 && (
              <div className="mcp-tools-list">
                {tools.map((tool) => (
                  <div key={tool.name} className="mcp-tool-item">
                    <div className="mcp-tool-name">{tool.name}</div>
                    {tool.originalName !== tool.name && (
                      <div className="mcp-tool-original">original: {tool.originalName}</div>
                    )}
                    <div className="mcp-tool-desc">{tool.description}</div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Tab: Resources */}
        {detailTab === 'resources' && (
          <div className="mcp-tab-content">
            {resourcesLoading && <div className="empty-state sm"><Loader2 className="spin" size={16} /> Loading resources...</div>}
            {!resourcesLoading && resources.length === 0 && resourceTemplates.length === 0 && activeServer?.status === 'connected' && (
              <div className="empty-state sm">No resources exposed by this server. <button className="link-btn" type="button" onClick={() => selected && handleLoadResources(selected)}>Refresh</button></div>
            )}
            {!resourcesLoading && activeServer?.status !== 'connected' && resources.length === 0 && (
              <div className="empty-state sm">Connect server to discover resources.</div>
            )}

            {resources.length > 0 && (
              <div className="mcp-resource-section">
                <div className="mcp-resource-section-title"><Database size={13} /> Resources ({resources.length})</div>
                <div className="mcp-resource-list">
                  {resources.map((res) => (
                    <div key={res.uri} className={`mcp-resource-item${readResult?.uri === res.uri ? ' active' : ''}`}>
                      <div className="mcp-resource-item-head">
                        <span className="mcp-resource-uri">{res.uri}</span>
                        <span className="mcp-resource-name">{res.title ?? res.name}</span>
                      </div>
                      {res.description && <div className="mcp-resource-desc">{res.description}</div>}
                      <div className="mcp-resource-actions">
                        <button className="shell-button sm" type="button" disabled={readLoading} onClick={() => selected && handleReadResource(selected, res.uri)}>
                          {readLoading && readResult === null ? <Loader2 className="spin" size={12} /> : <FileText size={12} />} Read
                        </button>
                        {res.mimeType && <span className="mcp-resource-mime">{res.mimeType}</span>}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {resourceTemplates.length > 0 && (
              <div className="mcp-resource-section">
                <div className="mcp-resource-section-title"><FileText size={13} /> Templates ({resourceTemplates.length})</div>
                <div className="mcp-resource-list">
                  {resourceTemplates.map((tmpl) => (
                    <div key={tmpl.uriTemplate} className="mcp-resource-item">
                      <div className="mcp-resource-item-head">
                        <span className="mcp-resource-uri">{tmpl.uriTemplate}</span>
                        <span className="mcp-resource-name">{tmpl.title ?? tmpl.name}</span>
                      </div>
                      {tmpl.description && <div className="mcp-resource-desc">{tmpl.description}</div>}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Read result viewer */}
            {readResult && (
              <div className="mcp-read-viewer">
                <div className="mcp-read-viewer-head">
                  <span className="mcp-read-viewer-uri">{readResult.uri}</span>
                  <button className="shell-button sm muted" type="button" onClick={() => setReadResult(null)}><X size={12} /> Close</button>
                </div>
                <div className="mcp-read-viewer-body">
                  {readResult.contents.map((content, i) => (
                    <pre key={i} className="mcp-read-viewer-pre">{content.text ?? (content.blob ? `[binary ${content.blob.length} bytes]` : '(empty)')}</pre>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {status && <div className="provider-status-bar">{status}</div>}
      </>
    );
  };

  return (
    <>
      <header className="settings-stage-head">
        <div>
          <div className="eyebrow">Configuration</div>
          <h2>MCP Servers</h2>
        </div>
        <div className="settings-stage-actions">
          <span className="badge">
            {servers.filter((s) => s.status === 'connected').length} connected
          </span>
          <button className="shell-button muted sm" type="button" onClick={loadStatus} disabled={loading}>
            {loading ? <Loader2 className="spin" size={14} /> : <RefreshCw size={14} />}
          </button>
        </div>
      </header>

      {/* Global Settings collapsible */}
      <div className="mcp-global-settings">
        <button className="mcp-global-settings-trigger" type="button" onClick={() => setSettingsOpen(!settingsOpen)}>
          {settingsOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          <span>Global Settings</span>
        </button>
        {settingsOpen && (
          <div className="mcp-global-settings-body">
            <div className="provider-field">
              <span className="provider-field-label">Tool Prefix</span>
              <select className="input" value={settingsPrefix} onChange={(e) => setSettingsPrefix(e.target.value as 'server' | 'none' | 'short')}>
                <option value="server">server (full name)</option>
                <option value="short">short (abbreviated)</option>
                <option value="none">none (no prefix)</option>
              </select>
              <span className="provider-field-hint">How MCP tool names are prefixed (e.g. servername_toolname)</span>
            </div>
            <div className="provider-field">
              <span className="provider-field-label">Idle Timeout (minutes)</span>
              <input className="input" type="number" min={0} value={settingsIdleTimeout}
                onChange={(e) => setSettingsIdleTimeout(e.target.value)} placeholder="10" />
              <span className="provider-field-hint">Disconnect idle servers after this many minutes (0 = never)</span>
            </div>

            <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 8 }}>
              <button className="shell-button primary sm" type="button" onClick={handleSaveSettings} disabled={settingsSaving}>
                {settingsSaving ? <Loader2 className="spin" size={13} /> : <Save size={13} />}
                Save Settings
              </button>
            </div>
          </div>
        )}
      </div>

      <div className="provider-layout">
        {/* Left: server list */}
        <section className="provider-catalog">
          <div className="provider-toolbar">
            <strong>Servers</strong>
            <button className="shell-button sm" type="button" onClick={startCreate}>
              <Plus size={14} /> Add
            </button>
          </div>
          <div className="provider-list">
            {loading && <div className="empty-state sm">Loading...</div>}
            {!loading && servers.length === 0 && (
              <div className="empty-state">No MCP servers configured.<br /><small>Add a server or edit .mcp.json</small></div>
            )}
            {servers.map((server) => (
              <button key={server.name} type="button"
                className={`provider-item${selected === server.name ? ' selected' : ''}`}
                onClick={() => selectServer(server.name)}>
                <div className="provider-item-icon">
                  {server.type === 'http' ? <Globe size={18} /> : <Terminal size={18} />}
                </div>
                <div className="provider-item-copy">
                  <strong>{server.name}</strong>
                  <small>{server.type === 'http' ? server.url : server.command}{server.status === 'connected' ? ` \u00b7 ${server.toolCount} tools` : ''}</small>
                </div>
                <label className="switch-row" onClick={(e) => e.stopPropagation()}>
                  <input
                    type="checkbox"
                    checked={server.status === 'connected'}
                    disabled={server.status === 'connecting'}
                    onChange={async () => {
                      try {
                        if (server.status === 'connected') {
                          await disconnectMcpServer(server.name);
                        } else {
                          await connectMcpServer(server.name);
                        }
                        await loadStatus();
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

        {/* Right: detail */}
        <section className="provider-detail">
          {!showEditor ? (
            <div className="empty-state lg">Select a server to view details, or click Add to configure one.</div>
          ) : (formMode === 'create' || formMode === 'edit') ? (
            renderServerForm()
          ) : (
            renderServerView()
          )}
        </section>
      </div>
    </>
  );
}
