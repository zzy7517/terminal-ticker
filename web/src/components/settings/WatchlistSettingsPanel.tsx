import { useMemo, useState } from 'react';
import { Loader2, Plus, Search, Trash2 } from 'lucide-react';
import type { Instrument, InstrumentCatalogItem, InstrumentSearchResult } from '../../types';
import type { SearchSource } from '../../constants';
import { useMarketStore } from '../../stores/marketStore';
import { removeWatchlistInstrument } from '../../api';
import {
  addInstrumentBySource,
  instrumentVenue,
  sourceName,
  watchlistSections,
} from '../../utils';

const SEARCH_LIMIT = 80;

function sourceTitle(source: SearchSource) {
  return source === 'bitget' ? 'Bitget Futures' : 'Hyperliquid Testnet';
}

function catalogMatches(item: InstrumentCatalogItem, query: string) {
  if (!query) return true;
  const haystack = [
    item.symbol,
    item.label,
    item.instType ?? '',
    item.key,
    item.displayText,
  ].join(' ').toLowerCase();
  return haystack.includes(query);
}

function catalogScore(item: InstrumentCatalogItem, query: string) {
  if (!query) return 0;
  const symbol = item.symbol.toLowerCase();
  const label = item.label.toLowerCase();
  const key = item.key.toLowerCase();
  if (symbol === query || label === query) return 0;
  if (symbol.startsWith(query) || label.startsWith(query)) return 1;
  if (key.startsWith(query)) return 2;
  return 3;
}

export function WatchlistSettingsPanel() {
  const state = useMarketStore((s) => s.state);
  const catalog = useMarketStore((s) => s.instrumentCatalog);
  const catalogLoadedAt = useMarketStore((s) => s.catalogLoadedAt);
  const catalogErrors = useMarketStore((s) => s.catalogErrors);
  const catalogStatus = useMarketStore((s) => s.catalogStatus);
  const [searchSource, setSearchSource] = useState<SearchSource>('bitget');
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('Catalog is loaded at startup. Search runs locally in the browser.');
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const editable = Boolean(state?.config.sourcePath);
  const sections = useMemo(() => watchlistSections(state?.instruments ?? []), [state?.instruments]);
  const activeKeys = useMemo(
    () => new Set((state?.instruments ?? []).map((instrument) => instrument.key)),
    [state?.instruments],
  );
  const normalizedQuery = query.trim().toLowerCase();
  const sourceCatalog = useMemo(
    () => catalog.filter((item) => item.source === searchSource),
    [catalog, searchSource],
  );
  const visibleCatalog = useMemo(
    () =>
      sourceCatalog
        .filter((item) => catalogMatches(item, normalizedQuery))
        .sort((a, b) => {
          const score = catalogScore(a, normalizedQuery) - catalogScore(b, normalizedQuery);
          return score || a.symbol.localeCompare(b.symbol);
        })
        .slice(0, SEARCH_LIMIT)
        .map((item) => ({ ...item, exists: activeKeys.has(item.key) })),
    [activeKeys, normalizedQuery, sourceCatalog],
  );
  const catalogErrorItems = Object.entries(catalogErrors);

  async function addResult(result: InstrumentSearchResult) {
    if (!editable || result.exists || busyKey) return;
    if (result.source === 'bitget' && !result.instType) {
      setStatus('Bitget result is missing instType.');
      return;
    }
    setBusyKey(result.key);
    setStatus(`Adding ${result.symbol}...`);
    try {
      const nextState = await addInstrumentBySource(result);
      useMarketStore.getState().setState(nextState);
      setStatus(`Added ${result.symbol}.`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Add failed.');
    } finally {
      setBusyKey(null);
    }
  }

  async function removeInstrument(instrument: Instrument) {
    if (!editable || busyKey) return;
    if ((state?.instruments.length ?? 0) <= 1) {
      setStatus('At least one symbol must stay in the watchlist.');
      return;
    }
    setBusyKey(instrument.key);
    setStatus(`Removing ${instrument.symbol}...`);
    try {
      const nextState = await removeWatchlistInstrument(instrument.key);
      useMarketStore.getState().setState(nextState);
      setStatus(`Removed ${instrument.symbol}.`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Remove failed.');
    } finally {
      setBusyKey(null);
    }
  }

  if (!state) {
    return <div className="settings-loading">Loading watchlist...</div>;
  }

  return (
    <>
      <header className="settings-stage-head">
        <div>
          <div className="eyebrow">Symbols</div>
          <h2>Watchlist</h2>
        </div>
        <div className="settings-stage-actions">
          <span className="models-count">{state.instruments.length} active</span>
        </div>
      </header>

      <div className="provider-layout watchlist-provider-layout">
        <section className="provider-catalog watchlist-catalog">
          <div className="provider-toolbar">
            <div className="settings-search">
              <Search size={17} />
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={
                  searchSource === 'bitget'
                    ? 'Search futures, e.g. BTCUSDT'
                    : 'Search coins, e.g. BTC'
                }
              />
            </div>
          </div>

          <div className="source-toggle watchlist-source-toggle">
            <button
              className={searchSource === 'bitget' ? 'active' : ''}
              type="button"
              onClick={() => setSearchSource('bitget')}
            >
              Bitget Futures
            </button>
            <button
              className={searchSource === 'hyperliquid-testnet' ? 'active' : ''}
              type="button"
              onClick={() => setSearchSource('hyperliquid-testnet')}
            >
              Hyperliquid
            </button>
          </div>

          <div className="models-showing watchlist-catalog-meta">
            {catalogStatus === 'loading'
              ? 'Loading catalog...'
              : `${visibleCatalog.length} shown of ${sourceCatalog.length} ${sourceTitle(searchSource)} symbols`}
            {catalogLoadedAt && <span>Loaded {new Date(catalogLoadedAt).toLocaleTimeString()}</span>}
          </div>

          {catalogErrorItems.length > 0 && (
            <div className="watchlist-catalog-errors">
              {catalogErrorItems.map(([source, message]) => (
                <div key={source}>
                  <strong>{sourceName(source)}</strong>
                  <span>{message}</span>
                </div>
              ))}
            </div>
          )}

          <div className="provider-list watchlist-catalog-list">
            {visibleCatalog.map((result) => (
              <button
                className={`provider-item watchlist-catalog-item ${result.exists ? 'selected' : ''}`}
                disabled={!editable || result.exists || busyKey === result.key}
                key={result.key}
                onClick={() => addResult(result)}
                type="button"
              >
                <div className="provider-item-copy">
                  <strong>{result.symbol}</strong>
                  <small>{result.displayText}</small>
                </div>
                <span className={result.exists ? 'remove-action' : 'add-action'}>
                  {busyKey === result.key ? <Loader2 className="spin" size={14} /> : <Plus size={14} />}
                  {result.exists ? 'Active' : 'Add'}
                </span>
              </button>
            ))}
            {visibleCatalog.length === 0 && (
              <div className="provider-empty">No symbols match this search.</div>
            )}
          </div>
        </section>

        <section className="provider-detail watchlist-detail">
          <div className="provider-hero">
            <div className="provider-hero-title">
              <h3>Active Symbols</h3>
              <span className="provider-state-badge active">{state.instruments.length} active</span>
              {!editable && <span className="provider-inline-badge">Readonly</span>}
            </div>
            <p>Search the preloaded provider catalog on the left, then add futures/perp symbols to the local watchlist.</p>
          </div>

          <div className="watchlist-table">
            {sections.map((section) => (
              <div className="watchlist-source-section" key={section.source}>
                <div className="watchlist-source-head">
                  <div>
                    <span>{section.label}</span>
                    <small>{sourceName(section.source)}</small>
                  </div>
                  <span className="source-count">{section.instruments.length}</span>
                </div>
                {section.instruments.map((instrument) => (
                  <div className="watchlist-table-row" key={instrument.key}>
                    <div>
                      <strong>{instrument.label}</strong>
                      <small>{instrument.symbol}</small>
                    </div>
                    <span>{sourceName(instrument.source)}</span>
                    <span>{instrumentVenue(instrument)}</span>
                    <span>{instrument.analysisInterval}</span>
                    <button
                      aria-label={`Remove ${instrument.symbol}`}
                      className="danger-icon-button"
                      disabled={!editable || state.instruments.length <= 1 || busyKey === instrument.key}
                      onClick={() => removeInstrument(instrument)}
                      type="button"
                    >
                      {busyKey === instrument.key ? <Loader2 className="spin" size={15} /> : <Trash2 size={15} />}
                    </button>
                  </div>
                ))}
              </div>
            ))}
          </div>

          <div className="provider-status-bar">{status}</div>
        </section>
      </div>
    </>
  );
}
