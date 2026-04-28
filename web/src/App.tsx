import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity,
  BarChart3,
  Bot,
  Check,
  Loader2,
  Minus,
  Plus,
  RefreshCw,
  Save,
  Search,
  Settings,
  Wifi,
  WifiOff,
} from 'lucide-react';
import {
  CandlestickSeries,
  ColorType,
  createChart,
  type IChartApi,
  type ISeriesApi,
  type UTCTimestamp,
} from 'lightweight-charts';
import {
  addLongbridgeSymbol,
  analyzeInstrument,
  connectStateSocket,
  fetchAgentModels,
  fetchState,
  removeLongbridgeSymbol,
  saveAgentConfig,
  searchSecurities,
} from './api';
import type {
  AgentConfigUpdate,
  AgentAnalysis,
  AgentModelOption,
  CandlePoint,
  Instrument,
  MarketState,
  Quote,
  SecuritySearchResult,
} from './types';

const GROUP_LABELS: Record<string, string> = {
  stocks: '美股',
  crypto: 'Crypto',
  metals: 'Metals',
  indices: 'Indices',
  watchlist: 'Watchlist',
  other: 'Other',
};

const REASONING_OPTIONS = ['low', 'medium', 'high', 'xhigh'];

function orderedGroups(state: MarketState | null) {
  if (!state) return [];
  const preferred = ['stocks', 'crypto', 'metals', 'indices', 'watchlist', 'other'];
  const present = Object.keys(state.groups);
  return [
    ...preferred.filter((group) => present.includes(group)),
    ...present.filter((group) => !preferred.includes(group)).sort(),
  ];
}

function changeClass(quote: Quote | undefined) {
  if (!quote || quote.change == null) return 'neutral';
  if (quote.change > 0) return 'up';
  if (quote.change < 0) return 'down';
  return 'neutral';
}

function analysisTone(quote: Quote | undefined) {
  const bias = quote?.priceAction?.bias;
  if (bias === 'bullish') return 'up';
  if (bias === 'bearish') return 'down';
  return 'neutral';
}

function agentTone(analysis: AgentAnalysis | undefined) {
  const bias = analysis?.bias;
  if (bias === 'bullish') return 'up';
  if (bias === 'bearish') return 'down';
  if (bias === 'mixed') return 'mixed';
  return 'neutral';
}

function sourceLabel(instrument: Instrument | undefined) {
  if (!instrument) return '-';
  return instrument.source === 'longbridge' ? 'Longbridge' : instrument.source.toUpperCase();
}

function formatLevelPrice(price: number | null) {
  if (price == null) return '-';
  return price.toFixed(price > 1000 ? 1 : 2);
}

function ConnectionBadge({ socketStatus, streamStatus }: { socketStatus: string; streamStatus: string }) {
  const connected = socketStatus === 'connected';
  return (
    <div className={`connection-badge ${connected ? 'live' : 'offline'}`}>
      {connected ? <Wifi size={15} /> : <WifiOff size={15} />}
      <span>{connected ? streamStatus : socketStatus}</span>
    </div>
  );
}

function CandlestickPane({ candles }: { candles: CandlePoint[] }) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const chart = createChart(container, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: '#0a0b0a' },
        textColor: 'rgba(237, 229, 217, 0.62)',
        fontFamily: 'Aptos, "Avenir Next", "Segoe UI", sans-serif',
      },
      grid: {
        vertLines: { color: 'rgba(214, 184, 154, 0.06)' },
        horzLines: { color: 'rgba(214, 184, 154, 0.08)' },
      },
      rightPriceScale: {
        borderColor: 'rgba(214, 184, 154, 0.10)',
        scaleMargins: { top: 0.12, bottom: 0.14 },
      },
      timeScale: {
        borderColor: 'rgba(214, 184, 154, 0.10)',
        timeVisible: true,
        secondsVisible: false,
      },
      crosshair: {
        vertLine: { color: 'rgba(226, 198, 162, 0.26)' },
        horzLine: { color: 'rgba(226, 198, 162, 0.26)' },
      },
      localization: {
        priceFormatter: (price: number) => price.toFixed(price > 1000 ? 1 : 2),
      },
    });

    const series = chart.addSeries(CandlestickSeries, {
      upColor: '#9fb08b',
      downColor: '#c87a63',
      wickUpColor: '#9fb08b',
      wickDownColor: '#c87a63',
      borderVisible: false,
    });
    chartRef.current = chart;
    seriesRef.current = series;

    return () => {
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
    };
  }, []);

  useEffect(() => {
    const data = candles.map((item) => ({
      time: item.time as UTCTimestamp,
      open: item.open,
      high: item.high,
      low: item.low,
      close: item.close,
    }));
    seriesRef.current?.setData(data);
    if (data.length > 0) {
      chartRef.current?.timeScale().fitContent();
    }
  }, [candles]);

  return (
    <div className="chart-shell">
      <div ref={containerRef} className="chart-canvas" />
      {candles.length === 0 && (
        <div className="chart-empty">
          <BarChart3 size={28} />
          <span>等待 K 线数据</span>
        </div>
      )}
    </div>
  );
}

function WatchlistRow({
  instrument,
  quote,
  selected,
  onSelect,
}: {
  instrument: Instrument;
  quote: Quote | undefined;
  selected: boolean;
  onSelect: () => void;
}) {
  const tone = analysisTone(quote);
  return (
    <button className={`watch-row ${selected ? 'selected' : ''}`} onClick={onSelect} type="button">
      <div className="watch-main">
        <div>
          <div className="symbol-line">
            <span>{instrument.label}</span>
            <small>{sourceLabel(instrument)}</small>
          </div>
          <div className="reason-line">{quote?.priceAction?.available ? quote.priceAction.reason : '等待分析'}</div>
        </div>
        <div className="price-stack">
          <strong>{quote?.priceLabel ?? '-'}</strong>
          <span className={changeClass(quote)}>{quote?.percentLabel ?? '-'}</span>
        </div>
      </div>
      <div className="watch-meta">
        <span className={`marker ${tone}`}>{quote?.priceAction?.marker || '--'}</span>
        <span>{quote?.ageLabel ?? 'waiting'}</span>
      </div>
    </button>
  );
}

function StatTile({ label, value }: { label: string; value: string }) {
  return (
    <div className="stat-tile">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function SearchPanel({
  onState,
}: {
  onState: (state: MarketState) => void;
}) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SecuritySearchResult[]>([]);
  const [status, setStatus] = useState('输入代码或名称');
  const [busySymbol, setBusySymbol] = useState<string | null>(null);

  async function runSearch() {
    const trimmed = query.trim();
    if (!trimmed) return;
    setStatus('搜索中...');
    try {
      const next = await searchSecurities(trimmed);
      setResults(next);
      setStatus(next.length ? `${next.length} 个结果` : '没有匹配结果');
    } catch (error) {
      setStatus(error instanceof Error ? error.message : '搜索失败');
    }
  }

  async function toggleResult(result: SecuritySearchResult) {
    setBusySymbol(result.symbol);
    try {
      const nextState = result.exists
        ? await removeLongbridgeSymbol(result.symbol)
        : await addLongbridgeSymbol(result);
      onState(nextState);
      setResults((items) =>
        items.map((item) =>
          item.symbol === result.symbol ? { ...item, exists: !result.exists } : item,
        ),
      );
      setStatus(result.exists ? `已移除 ${result.symbol}` : `已添加 ${result.symbol}`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : '操作失败');
    } finally {
      setBusySymbol(null);
    }
  }

  return (
    <section className="search-panel" aria-label="Longbridge stock search">
      <div className="search-box">
        <Search size={16} />
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') runSearch();
          }}
          placeholder="搜索美股代码 / 名称"
        />
        <button type="button" onClick={runSearch}>搜索</button>
      </div>
      <div className="search-status">{status}</div>
      {results.length > 0 && (
        <div className="search-results">
          {results.map((result) => (
            <button
              className="search-result"
              key={result.symbol}
              onClick={() => toggleResult(result)}
              type="button"
              disabled={busySymbol === result.symbol}
            >
              <span>
                <strong>{result.symbol}</strong>
                <small>{result.nameCn || result.nameEn || result.nameHk || result.displayText}</small>
              </span>
              <span className={result.exists ? 'remove-action' : 'add-action'}>
                {result.exists ? <Minus size={14} /> : <Plus size={14} />}
                {result.exists ? '移除' : '添加'}
              </span>
            </button>
          ))}
        </div>
      )}
    </section>
  );
}

function AgentReadout({
  analysis,
  busy,
  disabled,
  onAnalyze,
}: {
  analysis: AgentAnalysis | undefined;
  busy: boolean;
  disabled: boolean;
  onAnalyze: () => void;
}) {
  const tone = agentTone(analysis);
  return (
    <div className="agent-card agent-readout">
      <div className="agent-card-head">
        <span className="panel-label">Codex Read</span>
        <span className={`agent-bias ${tone}`}>{analysis?.bias ?? 'idle'}</span>
      </div>
      <p>
        {analysis?.available
          ? analysis.summary
          : analysis?.error || '把当前 quote、price action 和最近 OHLCV 交给 Codex provider 做一次结构化解读。'}
      </p>
      {analysis?.available && (
        <>
          <div className="agent-levels">
            {analysis.keyLevels.slice(0, 3).map((level, index) => (
              <div className="agent-level" key={`${level.label}-${index}`}>
                <span>{level.label || 'Level'}</span>
                <strong>{formatLevelPrice(level.price)}</strong>
                <small>{level.reason}</small>
              </div>
            ))}
          </div>
          <div className="agent-plan">
            {analysis.watchPlan.slice(0, 3).map((item, index) => (
              <div key={`${item}-${index}`}>{item}</div>
            ))}
          </div>
          {analysis.invalidation && (
            <div className="agent-invalidation">
              <span>Invalidation</span>
              <strong>{analysis.invalidation}</strong>
            </div>
          )}
        </>
      )}
      <button className="agent-action" type="button" onClick={onAnalyze} disabled={disabled || busy}>
        {busy ? <Loader2 className="spin" size={16} /> : <Bot size={16} />}
        {busy ? 'Analyzing' : 'Ask Codex'}
      </button>
    </div>
  );
}

function AgentConfigPanel({
  state,
  onState,
}: {
  state: MarketState | null;
  onState: (state: MarketState) => void;
}) {
  const config = state?.config.agent;
  const configSignature = config ? JSON.stringify(config) : '';
  const [draft, setDraft] = useState<AgentConfigUpdate | null>(null);
  const [models, setModels] = useState<AgentModelOption[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState('not refreshed');

  useEffect(() => {
    if (!config) return;
    setDraft({
      enabled: config.enabled,
      provider: config.provider,
      apiMode: config.apiMode,
      model: config.model,
      baseUrl: config.baseUrl,
      timeoutSeconds: config.timeoutSeconds,
      maxCandles: config.maxCandles,
      reasoningEffort: config.reasoningEffort,
    });
  }, [configSignature]);

  async function refreshModels() {
    setRefreshing(true);
    setStatus('refreshing...');
    try {
      const payload = await fetchAgentModels();
      const visible = payload.models.filter((model) => model.supportedInApi && model.visibility !== 'hide');
      setModels(visible);
      setStatus(`${visible.length} models`);
      if (draft && !visible.some((model) => model.slug === draft.model) && visible[0]) {
        setDraft({
          ...draft,
          model: visible[0].slug,
          reasoningEffort: visible[0].defaultReasoningEffort || draft.reasoningEffort,
        });
      }
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'refresh failed');
    } finally {
      setRefreshing(false);
    }
  }

  async function persistConfig() {
    if (!draft) return;
    setSaving(true);
    setStatus('saving...');
    try {
      const nextState = await saveAgentConfig(draft);
      onState(nextState);
      setStatus('saved');
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'save failed');
    } finally {
      setSaving(false);
    }
  }

  if (!draft) {
    return (
      <div className="agent-card dense">
        <span className="panel-label">Agent Config</span>
        <p>loading</p>
      </div>
    );
  }

  const modelOptions = models.some((model) => model.slug === draft.model)
    ? models
    : [
        {
          slug: draft.model,
          displayName: draft.model,
          description: '',
          visibility: 'active',
          supportedInApi: true,
          defaultReasoningEffort: draft.reasoningEffort,
          supportedReasoningEfforts: REASONING_OPTIONS,
          contextWindow: null,
          preferWebsockets: true,
        },
        ...models,
      ];
  const selectedModel = models.find((model) => model.slug === draft.model);
  const reasoningOptions = selectedModel?.supportedReasoningEfforts.length
    ? selectedModel.supportedReasoningEfforts
    : REASONING_OPTIONS;

  return (
    <div className="agent-card agent-config-card">
      <div className="agent-card-head">
        <span className="panel-label">Agent Config</span>
        <Settings size={16} />
      </div>
      <div className="config-form">
        <label className="toggle-row">
          <input
            checked={draft.enabled}
            onChange={(event) => setDraft({ ...draft, enabled: event.target.checked })}
            type="checkbox"
          />
          <span>Enabled</span>
        </label>
        <label>
          <span>Provider</span>
          <select
            value={draft.provider}
            onChange={(event) => setDraft({ ...draft, provider: event.target.value, apiMode: 'codex_responses' })}
          >
            <option value="codex">Codex</option>
          </select>
        </label>
        <label>
          <span>Model</span>
          <select
            value={draft.model}
            onChange={(event) => {
              const model = models.find((item) => item.slug === event.target.value);
              setDraft({
                ...draft,
                model: event.target.value,
                reasoningEffort: model?.defaultReasoningEffort || draft.reasoningEffort,
              });
            }}
          >
            {modelOptions.map((model) => (
              <option key={model.slug} value={model.slug}>
                {model.displayName || model.slug}
              </option>
            ))}
          </select>
        </label>
        <div className="config-grid">
          <label>
            <span>Reasoning</span>
            <select
              value={draft.reasoningEffort}
              onChange={(event) => setDraft({ ...draft, reasoningEffort: event.target.value })}
            >
              {reasoningOptions.map((option) => (
                <option key={option} value={option}>{option}</option>
              ))}
            </select>
          </label>
          <label>
            <span>Candles</span>
            <input
              min={10}
              step={5}
              type="number"
              value={draft.maxCandles}
              onChange={(event) =>
                setDraft({ ...draft, maxCandles: Math.max(10, Number(event.target.value) || 10) })
              }
            />
          </label>
        </div>
        <div className="config-grid">
          <label>
            <span>Timeout</span>
            <input
              min={5}
              step={5}
              type="number"
              value={draft.timeoutSeconds}
              onChange={(event) =>
                setDraft({ ...draft, timeoutSeconds: Math.max(5, Number(event.target.value) || 5) })
              }
            />
          </label>
          <label>
            <span>Mode</span>
            <input readOnly value={draft.apiMode} />
          </label>
        </div>
        <label>
          <span>Base URL</span>
          <input
            value={draft.baseUrl ?? ''}
            onChange={(event) => setDraft({ ...draft, baseUrl: event.target.value.trim() || null })}
            placeholder="default"
          />
        </label>
      </div>
      <div className="config-actions">
        <button className="agent-action secondary" disabled={refreshing} onClick={refreshModels} type="button">
          {refreshing ? <Loader2 className="spin" size={16} /> : <RefreshCw size={16} />}
          Refresh models
        </button>
        <button className="agent-action" disabled={saving} onClick={persistConfig} type="button">
          {saving ? <Loader2 className="spin" size={16} /> : <Save size={16} />}
          Save
        </button>
      </div>
      <div className="config-status">{status}</div>
    </div>
  );
}

export default function App() {
  const [state, setState] = useState<MarketState | null>(null);
  const [socketStatus, setSocketStatus] = useState('connecting');
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [activeGroup, setActiveGroup] = useState<string | null>(null);
  const [agentBusyKey, setAgentBusyKey] = useState<string | null>(null);

  useEffect(() => {
    let disposed = false;
    let retryTimer: number | undefined;
    let socket: WebSocket | undefined;

    const scheduleReconnect = () => {
      if (disposed || retryTimer !== undefined) return;
      retryTimer = window.setTimeout(() => {
        retryTimer = undefined;
        openSocket();
      }, 1500);
    };

    const openSocket = () => {
      if (disposed) return;
      setSocketStatus('connecting');
      socket = connectStateSocket(setState, (status) => {
        setSocketStatus(status);
        if (status === 'disconnected' || status === 'error') {
          scheduleReconnect();
        }
      });
    };

    fetchState().then(setState).catch(() => setSocketStatus('error'));
    openSocket();
    return () => {
      disposed = true;
      if (retryTimer !== undefined) {
        window.clearTimeout(retryTimer);
      }
      socket?.close();
    };
  }, []);

  const groups = useMemo(() => orderedGroups(state), [state]);

  useEffect(() => {
    if (!state) return;
    if (!activeGroup || !state.groups[activeGroup]) {
      setActiveGroup(groups[0] ?? null);
    }
    if (!selectedKey || !state.quotes[selectedKey]) {
      const firstKey = groups.flatMap((group) => state.groups[group] ?? [])[0];
      setSelectedKey(firstKey ?? null);
    }
  }, [activeGroup, groups, selectedKey, state]);

  const activeKeys = activeGroup && state ? state.groups[activeGroup] ?? [] : [];
  const selectedInstrument = state?.instruments.find((instrument) => instrument.key === selectedKey);
  const selectedQuote = selectedKey ? state?.quotes[selectedKey] : undefined;
  const selectedAgent = selectedKey ? state?.agentAnalyses[selectedKey] : undefined;
  const tone = analysisTone(selectedQuote);

  async function runAgentAnalysis() {
    if (!selectedKey) return;
    setAgentBusyKey(selectedKey);
    try {
      const payload = await analyzeInstrument(selectedKey);
      setState(payload.state);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'agent analysis failed';
      const fallback: AgentAnalysis = {
        available: false,
        provider: state?.config.agent.provider ?? 'codex',
        model: state?.config.agent.model ?? '-',
        updatedAt: new Date().toISOString(),
        summary: '',
        bias: 'neutral',
        confidence: 0,
        keyLevels: [],
        watchPlan: [],
        invalidation: '',
        riskNotes: [],
        error: message,
        rawText: null,
      };
      setState((current) =>
        current && selectedKey
          ? {
              ...current,
              agentAnalyses: {
                ...current.agentAnalyses,
                [selectedKey]: fallback,
              },
            }
          : current,
      );
    } finally {
      setAgentBusyKey(null);
    }
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <div>
          <div className="eyebrow">Local Price Action Agent</div>
          <h1>Terminal Ticker</h1>
        </div>
        <div className="topbar-right">
          <ConnectionBadge socketStatus={socketStatus} streamStatus={state?.streamStatus ?? 'idle'} />
          <div className="interval-pill">
            <Activity size={15} />
            {state?.config.analysis.interval ?? '5m'}
          </div>
        </div>
      </header>

      <section className="workspace">
        <aside className="sidebar">
          <div className="sidebar-head">
            <span>Watchlist</span>
            <small>{state?.instruments.length ?? 0} symbols</small>
          </div>
          <div className="group-tabs">
            {groups.map((group) => (
              <button
                className={group === activeGroup ? 'active' : ''}
                key={group}
                type="button"
                onClick={() => setActiveGroup(group)}
              >
                {GROUP_LABELS[group] ?? group}
              </button>
            ))}
          </div>
          <div className="watchlist">
            {state &&
              activeKeys.map((key) => {
                const instrument = state.instruments.find((item) => item.key === key);
                if (!instrument) return null;
                return (
                  <WatchlistRow
                    key={key}
                    instrument={instrument}
                    quote={state.quotes[key]}
                    selected={selectedKey === key}
                    onSelect={() => setSelectedKey(key)}
                  />
                );
              })}
          </div>
          <SearchPanel onState={setState} />
        </aside>

        <section className="chart-panel">
          <div className="chart-header">
            <div>
              <div className="instrument-kicker">{sourceLabel(selectedInstrument)}</div>
              <h2>{selectedInstrument?.label ?? '选择标的'}</h2>
            </div>
            <div className="price-readout">
              <strong>{selectedQuote?.priceLabel ?? '-'}</strong>
              <span className={changeClass(selectedQuote)}>
                {selectedQuote?.changeLabel ?? '-'} · {selectedQuote?.percentLabel ?? '-'}
              </span>
            </div>
          </div>

          <div className="analysis-strip">
            <div className={`analysis-marker ${tone}`}>
              {selectedQuote?.priceAction?.marker || '--'}
            </div>
            <div>
              <strong>
                {selectedQuote?.priceAction?.available
                  ? selectedQuote.priceAction.reason
                  : selectedQuote?.priceAction?.reason || '等待 price action 分析'}
              </strong>
              <span>
                {selectedQuote?.priceAction?.available
                  ? `${selectedQuote.priceAction.label} · strength ${selectedQuote.priceAction.strength}`
                  : '缺少新鲜 K 线时不会展示信号'}
              </span>
            </div>
            {selectedQuote?.priceAction?.available && <Check className="analysis-check" size={18} />}
          </div>

          <CandlestickPane candles={selectedQuote?.candles ?? []} />

          <div className="stat-grid">
            <StatTile label="High" value={selectedQuote?.dayHigh?.toFixed(2) ?? '-'} />
            <StatTile label="Low" value={selectedQuote?.dayLow?.toFixed(2) ?? '-'} />
            <StatTile label="Volume" value={selectedQuote?.volumeLabel ?? '-'} />
            <StatTile label="Age" value={selectedQuote?.ageLabel ?? 'waiting'} />
          </div>
        </section>

        <aside className="agent-panel">
          <AgentReadout
            analysis={selectedAgent}
            busy={agentBusyKey === selectedKey}
            disabled={!selectedKey || !selectedQuote?.candles.length || !state?.config.agent.enabled}
            onAnalyze={runAgentAnalysis}
          />
          <div className="agent-card">
            <span className="panel-label">Agent State</span>
            <h3>{selectedQuote?.priceAction?.label ?? 'unavailable'}</h3>
            <p>
              {selectedQuote?.priceAction?.available
                ? selectedQuote.priceAction.reason
                : '系统直接分析 OHLCV，不读取屏幕截图；数据缺失、过期或接口失败时保持不可用。'}
            </p>
          </div>
          <div className="agent-card dense">
            <span className="panel-label">Feed</span>
            <div className="kv-row">
              <span>Status</span>
              <strong>{state?.streamStatus ?? 'idle'}</strong>
            </div>
            <div className="kv-row">
              <span>Updated</span>
              <strong>{state ? new Date(state.updatedAt).toLocaleTimeString() : '-'}</strong>
            </div>
            <div className="kv-row">
              <span>Source</span>
              <strong>{sourceLabel(selectedInstrument)}</strong>
            </div>
          </div>
          <AgentConfigPanel state={state} onState={setState} />
          <div className="agent-card dense">
            <span className="panel-label">Boundary</span>
            <p>本地监控和解释层，不下单、不管理仓位、不生成买卖按钮。</p>
          </div>
          <button className="refresh-button" type="button" onClick={() => fetchState().then(setState)}>
            <RefreshCw size={16} />
            Refresh snapshot
          </button>
        </aside>
      </section>
    </main>
  );
}
