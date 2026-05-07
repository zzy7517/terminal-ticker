import { useMemo, useState } from 'react';
import { Loader2, Plus, Search, Trash2 } from 'lucide-react';
import type { Instrument, InstrumentSearchResult } from '../../types';
import type { SearchSource } from '../../constants';
import { useMarketStore } from '../../stores/marketStore';
import {
  addAlpacaSymbol,
  addBitgetSymbol,
  addHyperliquidTestnetSymbol,
  removeWatchlistInstrument,
  searchInstruments,
} from '../../api';
import {
  instrumentVenue,
  parseBulkEntries,
  resultFromBulkEntry,
  sourceName,
  watchlistSections,
} from '../../utils';

export function WatchlistSettingsPanel() {
  const state = useMarketStore((s) => s.state);
  const [searchSource, setSearchSource] = useState<SearchSource>('bitget');
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<InstrumentSearchResult[]>([]);
  const [status, setStatus] = useState('Watchlist changes are saved to the local TOML file.');
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [bulkText, setBulkText] = useState('');
  const [bulkBusy, setBulkBusy] = useState(false);
  const entries = useMemo(() => parseBulkEntries(bulkText, state), [bulkText, state]);
  const addableEntries = entries.filter((entry) => entry.valid && !entry.exists && !entry.inputDuplicate);
  const editable = Boolean(state?.config.sourcePath);
  const sections = useMemo(() => watchlistSections(state?.instruments ?? []), [state?.instruments]);

  async function addWatchlistResult(result: InstrumentSearchResult) {
    if (result.source === 'bitget') return addBitgetSymbol(result);
    if (result.source === 'hyperliquid-testnet') return addHyperliquidTestnetSymbol(result);
    return addAlpacaSymbol(result);
  }

  async function addResult(result: InstrumentSearchResult) {
    if (result.exists || busyKey) return;
    if (result.source === 'bitget' && !result.instType) {
      setStatus('Bitget result is missing instType.');
      return;
    }
    setBusyKey(result.key);
    setStatus(`Adding ${result.symbol}...`);
    try {
      const nextState = await addWatchlistResult(result);
      useMarketStore.getState().setState(nextState);
      setResults((items) =>
        items.map((item) => (item.key === result.key ? { ...item, exists: true } : item)),
      );
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
      setResults((items) =>
        items.map((item) => (item.key === instrument.key ? { ...item, exists: false } : item)),
      );
      setStatus(`Removed ${instrument.symbol}.`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Remove failed.');
    } finally {
      setBusyKey(null);
    }
  }

  async function runSearch() {
    const trimmed = query.trim();
    if (!trimmed) return;
    setStatus('Searching...');
    try {
      const next = await searchInstruments(searchSource, trimmed);
      setResults(next);
      setStatus(next.length ? `${next.length} matches.` : 'No matches.');
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Search failed.');
    }
  }

  async function addBulkEntries() {
    if (!editable || bulkBusy || addableEntries.length === 0) return;
    setBulkBusy(true);
    setStatus(`Adding ${addableEntries.length} symbols...`);
    try {
      let added = 0;
      for (const entry of addableEntries) {
        const result = resultFromBulkEntry(entry);
        const nextState = await addWatchlistResult(result);
        added += 1;
        useMarketStore.getState().setState(nextState);
      }
      setStatus(`Added ${added} symbols.`);
      setBulkText('');
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Batch add failed.');
    } finally {
      setBulkBusy(false);
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

      <div className="watchlist-settings-layout">
        <section className="watchlist-current">
          <div className="provider-section-head">
            <strong>Active Symbols</strong>
            {!editable && <span className="provider-inline-badge">Readonly</span>}
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
        </section>

        <section className="watchlist-editor">
          <div className="bulk-import-panel">
            <div className="provider-section-head">
              <strong>Batch Add</strong>
              <span className="provider-inline-badge">{addableEntries.length} ready</span>
            </div>
            <textarea
              value={bulkText}
              onChange={(event) => setBulkText(event.target.value)}
              placeholder={'BTCUSDT\nSPOT:ETHUSDT\nAAPL.US\nhyperliquid:BTC'}
              spellCheck={false}
            />
            {entries.length > 0 && (
              <div className="bulk-preview">
                {entries.slice(0, 8).map((entry) => (
                  <div className={`bulk-preview-row ${entry.valid && !entry.exists ? 'ready' : ''}`} key={`${entry.raw}-${entry.key}`}>
                    <span>{entry.raw}</span>
                    <small>
                      {entry.error
                        || (entry.inputDuplicate ? 'duplicate input' : entry.exists ? 'already active' : `${sourceName(entry.source)} · ${entry.key}`)}
                    </small>
                  </div>
                ))}
                {entries.length > 8 && <div className="bulk-preview-more">+{entries.length - 8} more</div>}
              </div>
            )}
            <button
              className="shell-button primary"
              disabled={!editable || bulkBusy || addableEntries.length === 0}
              onClick={addBulkEntries}
              type="button"
            >
              {bulkBusy ? <Loader2 className="spin" size={16} /> : <Plus size={16} />}
              Add batch
            </button>
          </div>

          <div className="single-add-panel">
            <div className="provider-section-head">
              <strong>Search Add</strong>
              <span className="provider-inline-badge">{sourceName(searchSource)}</span>
            </div>
            <div className="source-toggle">
              <button
                className={searchSource === 'bitget' ? 'active' : ''}
                type="button"
                onClick={() => {
                  setSearchSource('bitget');
                  setResults([]);
                }}
              >
                Bitget
              </button>
              <button
                className={searchSource === 'alpaca' ? 'active' : ''}
                type="button"
                onClick={() => {
                  setSearchSource('alpaca');
                  setResults([]);
                }}
              >
                Alpaca
              </button>
              <button
                className={searchSource === 'hyperliquid-testnet' ? 'active' : ''}
                type="button"
                onClick={() => {
                  setSearchSource('hyperliquid-testnet');
                  setResults([]);
                }}
              >
                Hyperliquid Testnet
              </button>
            </div>
            <div className="settings-search">
              <Search size={17} />
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') runSearch();
                }}
                placeholder={
                  searchSource === 'bitget'
                    ? 'BTC / BTCUSDT'
                    : searchSource === 'hyperliquid-testnet'
                      ? 'BTC / ETH'
                      : 'AAPL / Apple'
                }
              />
              <button className="inline-search-button" type="button" onClick={runSearch}>
                Search
              </button>
            </div>
            <div className="search-results settings-results">
              {results.map((result) => (
                <button
                  className="search-result"
                  key={result.key}
                  onClick={() => addResult(result)}
                  type="button"
                  disabled={!editable || result.exists || busyKey === result.key}
                >
                  <span>
                    <strong>{result.symbol}</strong>
                    <small>{result.nameCn || result.nameEn || result.nameHk || result.displayText}</small>
                  </span>
                  <span className={result.exists ? 'remove-action' : 'add-action'}>
                    {busyKey === result.key ? <Loader2 className="spin" size={14} /> : <Plus size={14} />}
                    {result.exists ? 'Active' : 'Add'}
                  </span>
                </button>
              ))}
            </div>
          </div>
        </section>
      </div>

      <div className="provider-status-bar">{status}</div>
    </>
  );
}
