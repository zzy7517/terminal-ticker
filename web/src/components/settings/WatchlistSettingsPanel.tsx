import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, Loader2, Plus, Search, Sparkles, X } from 'lucide-react';
import type { Instrument, InstrumentCatalogItem, InstrumentSearchResult } from '../../types';
import type { SearchSource } from '../../constants';
import { useMarketStore } from '../../stores/marketStore';
import { removeWatchlistInstrument } from '../../api';
import { addInstrumentBySource, sourceName } from '../../utils';
import './WatchlistSettingsPanel.css';

const SOURCE_LABEL: Record<SearchSource, string> = {
  bitget: 'Bitget Futures',
  hyperliquid: 'Hyperliquid',
};

const SOURCE_ORDER: SearchSource[] = ['bitget', 'hyperliquid'];

const QUOTE_FILTERS = [
  { id: 'all', label: 'All' },
  { id: 'USDT', label: 'USDT' },
  { id: 'USDC', label: 'USDC' },
  { id: 'USD', label: 'USD' },
] as const;
type QuoteFilter = (typeof QUOTE_FILTERS)[number]['id'];

const HYPERLIQUID_GROUP_FILTERS = [
  { id: 'tradefi', label: 'TradeFi' },
  { id: 'all', label: 'All' },
  { id: 'stocks', label: 'Stocks' },
  { id: 'indices', label: 'Indices' },
  { id: 'commodities', label: 'Commodities' },
  { id: 'fx', label: 'FX' },
  { id: 'preipo', label: 'Pre-IPO' },
  { id: 'crypto', label: 'Crypto' },
] as const;
type HyperliquidGroupFilter = (typeof HYPERLIQUID_GROUP_FILTERS)[number]['id'];
const TRADEFI_GROUPS = new Set(['stocks', 'indices', 'commodities', 'fx', 'preipo']);

function bucketOf(symbol: string): string {
  const ch = symbol.charAt(0).toUpperCase();
  return ch >= 'A' && ch <= 'Z' ? ch : '#';
}

function inferQuote(item: InstrumentCatalogItem): string {
  // Bitget futures symbols look like BTCUSDT / ETHUSDC. Hyperliquid coins (BTC) have no quote suffix.
  const upper = item.symbol.toUpperCase();
  for (const q of ['USDT', 'USDC', 'USD']) {
    if (upper.endsWith(q)) return q;
  }
  return '';
}

function inferHyperliquidGroup(item: InstrumentCatalogItem): string {
  return (item.group ?? item.category ?? 'crypto').toLowerCase();
}

function matchesQuery(item: InstrumentCatalogItem, query: string): boolean {
  if (!query) return true;
  const haystack = [item.symbol, item.label, item.instType ?? '', item.key, item.displayText]
    .join(' ')
    .toLowerCase();
  return haystack.includes(query);
}

function queryRank(item: InstrumentCatalogItem, query: string): number {
  if (!query) return 0;
  const symbol = item.symbol.toLowerCase();
  const label = item.label.toLowerCase();
  if (symbol === query || label === query) return 0;
  if (symbol.startsWith(query) || label.startsWith(query)) return 1;
  if (item.key.toLowerCase().startsWith(query)) return 2;
  return 3;
}

interface CatalogGroup {
  letter: string;
  items: Array<InstrumentCatalogItem & { exists: boolean }>;
}

export function WatchlistSettingsPanel() {
  const state = useMarketStore((s) => s.state);
  const catalog = useMarketStore((s) => s.instrumentCatalog);
  const catalogLoadedAt = useMarketStore((s) => s.catalogLoadedAt);
  const catalogErrors = useMarketStore((s) => s.catalogErrors);
  const catalogStatus = useMarketStore((s) => s.catalogStatus);

  const [searchSource, setSearchSource] = useState<SearchSource>('bitget');
  const [query, setQuery] = useState('');
  const [quote, setQuote] = useState<QuoteFilter>('all');
  const [hyperliquidGroup, setHyperliquidGroup] = useState<HyperliquidGroupFilter>('tradefi');
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  const scrollerRef = useRef<HTMLDivElement | null>(null);

  const editable = Boolean(state?.config.sourcePath);
  const instruments = state?.instruments ?? [];
  const activeKeys = useMemo(
    () => new Set(instruments.map((i) => i.key)),
    [instruments],
  );

  const sourceCatalog = useMemo(
    () => catalog.filter((item) => item.source === searchSource),
    [catalog, searchSource],
  );

  const availableQuotes = useMemo(() => {
    const set = new Set<string>();
    for (const item of sourceCatalog) {
      const q = inferQuote(item);
      if (q) set.add(q);
    }
    return set;
  }, [sourceCatalog]);

  const normalizedQuery = query.trim().toLowerCase();

  const groups = useMemo<CatalogGroup[]>(() => {
    const filtered = sourceCatalog.filter((item) => {
      if (!matchesQuery(item, normalizedQuery)) return false;
      if (quote !== 'all') {
        if (inferQuote(item) !== quote) return false;
      }
      if (searchSource === 'hyperliquid' && hyperliquidGroup !== 'all') {
        const group = inferHyperliquidGroup(item);
        if (hyperliquidGroup === 'tradefi') {
          if (!TRADEFI_GROUPS.has(group)) return false;
        } else if (group !== hyperliquidGroup) {
          return false;
        }
      }
      return true;
    });

    filtered.sort((a, b) => {
      const r = queryRank(a, normalizedQuery) - queryRank(b, normalizedQuery);
      return r || a.symbol.localeCompare(b.symbol);
    });

    const decorated = filtered.map((item) => ({ ...item, exists: activeKeys.has(item.key) }));

    const map = new Map<string, CatalogGroup>();
    for (const item of decorated) {
      const letter = bucketOf(item.symbol);
      let g = map.get(letter);
      if (!g) {
        g = { letter, items: [] };
        map.set(letter, g);
      }
      g.items.push(item);
    }
    return Array.from(map.values()).sort((a, b) => {
      if (a.letter === '#') return 1;
      if (b.letter === '#') return -1;
      return a.letter.localeCompare(b.letter);
    });
  }, [sourceCatalog, normalizedQuery, quote, hyperliquidGroup, searchSource, activeKeys]);

  const visibleLetters = useMemo(() => new Set(groups.map((g) => g.letter)), [groups]);
  const totalShown = useMemo(() => groups.reduce((acc, g) => acc + g.items.length, 0), [groups]);
  const catalogErrorItems = Object.entries(catalogErrors);

  // Reset query/quote on source switch so user doesn't get stuck on an empty list.
  useEffect(() => {
    setQuery('');
    setQuote('all');
    setHyperliquidGroup(searchSource === 'hyperliquid' ? 'tradefi' : 'all');
    if (scrollerRef.current) scrollerRef.current.scrollTop = 0;
  }, [searchSource]);

  function jumpToLetter(letter: string) {
    const scroller = scrollerRef.current;
    const el = scroller?.querySelector<HTMLElement>(`[data-letter="${letter}"]`);
    if (!scroller || !el) return;
    const elRect = el.getBoundingClientRect();
    const scrollerRect = scroller.getBoundingClientRect();
    const offset = elRect.top - scrollerRect.top + scroller.scrollTop;
    scroller.scrollTo({ top: Math.max(offset - 4, 0), behavior: 'smooth' });
  }

  async function handleAdd(result: InstrumentSearchResult) {
    if (!editable || result.exists || busyKey) return;
    if (result.source === 'bitget' && !result.instType) {
      setStatus('Bitget result is missing instType.');
      return;
    }
    setBusyKey(result.key);
    setStatus(`Adding ${result.symbol}…`);
    try {
      const next = await addInstrumentBySource(result);
      useMarketStore.getState().setState(next);
      setStatus(`Added ${result.symbol}.`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Add failed.');
    } finally {
      setBusyKey(null);
    }
  }

  async function handleRemove(instrument: Instrument) {
    if (!editable || busyKey) return;
    if (instruments.length <= 1) {
      setStatus('At least one symbol must stay in the watchlist.');
      return;
    }
    setBusyKey(instrument.key);
    setStatus(`Removing ${instrument.symbol}…`);
    try {
      const next = await removeWatchlistInstrument(instrument.key);
      useMarketStore.getState().setState(next);
      setStatus(`Removed ${instrument.symbol}.`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Remove failed.');
    } finally {
      setBusyKey(null);
    }
  }

  if (!state) {
    return <div className="empty-state lg">Loading watchlist…</div>;
  }

  return (
    <>
      <header className="settings-stage-head wl-head">
        <div>
          <div className="eyebrow">Symbols</div>
          <h2>Watchlist</h2>
        </div>
        <div className="settings-stage-actions">
          <span className="badge mono">{instruments.length} active</span>
          {!editable && <span className="badge">Readonly</span>}
        </div>
      </header>

      <section className="wl-browse" aria-label="Watchlist">
        <div className="wl-active" aria-label="Active symbols">
          <div className="wl-active-head">
            <span className="wl-active-eyebrow">In your watchlist</span>
            <span className="badge accent mono">
              <Sparkles size={12} aria-hidden /> {instruments.length}
            </span>
          </div>
          {instruments.length === 0 ? (
            <p className="empty-state sm">
              No symbols yet. Add some from the catalog below to start streaming quotes.
            </p>
          ) : (
            <ul className="wl-chips">
              {instruments.map((instrument) => {
                const removing = busyKey === instrument.key;
                const disabled = !editable || instruments.length <= 1 || Boolean(busyKey);
                return (
                  <li key={instrument.key} className={`wl-chip ${removing ? 'is-busy' : ''}`}>
                    <span className="wl-chip-label">{instrument.label}</span>
                    <span className="wl-chip-symbol">{instrument.symbol}</span>
                    <span className="wl-chip-meta">
                      <span>{sourceName(instrument.source)}</span>
                      <span className="wl-chip-dot" aria-hidden>·</span>
                      <span>{instrument.analysisInterval}</span>
                    </span>
                    <button
                      type="button"
                      className="wl-chip-remove"
                      aria-label={`Remove ${instrument.symbol}`}
                      disabled={disabled}
                      onClick={() => handleRemove(instrument)}
                    >
                      {removing ? <Loader2 size={13} className="spin" /> : <X size={13} />}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <div className="wl-browse-toolbar">
          <div className="wl-source-tabs" role="tablist" aria-label="Catalog source">
            {SOURCE_ORDER.map((src) => {
              const count = catalog.filter((c) => c.source === src).length;
              return (
                <button
                  key={src}
                  type="button"
                  role="tab"
                  aria-selected={searchSource === src}
                  className={`wl-source-tab ${searchSource === src ? 'active' : ''}`}
                  onClick={() => setSearchSource(src)}
                >
                  <span>{SOURCE_LABEL[src]}</span>
                  <span className="wl-source-tab-count">{count.toLocaleString()}</span>
                </button>
              );
            })}
          </div>

          <div className="wl-search">
            <Search size={16} aria-hidden />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={
                searchSource === 'bitget'
                  ? 'Search Bitget futures (e.g. BTCUSDT)'
                  : 'Search Hyperliquid TradeFi (e.g. NVDA, AAPL, GOLD)'
              }
              aria-label="Filter catalog"
            />
            {query && (
              <button
                type="button"
                className="wl-search-clear"
                aria-label="Clear search"
                onClick={() => setQuery('')}
              >
                <X size={13} />
              </button>
            )}
          </div>
        </div>

        <div className="wl-browse-meta">
          <span>
            {catalogStatus === 'loading'
              ? 'Loading catalog…'
              : `${totalShown.toLocaleString()} of ${sourceCatalog.length.toLocaleString()} ${SOURCE_LABEL[searchSource]} symbols`}
          </span>
          {catalogLoadedAt && (
            <span className="wl-browse-meta-loaded">
              Cached at {new Date(catalogLoadedAt).toLocaleTimeString()}
            </span>
          )}
        </div>

        {searchSource === 'bitget' && availableQuotes.size > 0 && (
          <div className="wl-quote-filter" role="group" aria-label="Quote currency">
            {QUOTE_FILTERS.map((q) => {
              const enabled = q.id === 'all' || availableQuotes.has(q.id);
              return (
                <button
                  key={q.id}
                  type="button"
                  className={`wl-quote-pill ${quote === q.id ? 'active' : ''}`}
                  disabled={!enabled}
                  onClick={() => setQuote(q.id as QuoteFilter)}
                >
                  {q.label}
                </button>
              );
            })}
          </div>
        )}

        {searchSource === 'hyperliquid' && (
          <div className="wl-quote-filter" role="group" aria-label="Hyperliquid category">
            {HYPERLIQUID_GROUP_FILTERS.map((item) => (
              <button
                key={item.id}
                type="button"
                className={`wl-quote-pill ${hyperliquidGroup === item.id ? 'active' : ''}`}
                onClick={() => setHyperliquidGroup(item.id)}
              >
                {item.label}
              </button>
            ))}
          </div>
        )}

        {catalogErrorItems.length > 0 && (
          <div className="wl-errors">
            {catalogErrorItems.map(([source, message]) => (
              <div key={source}>
                <strong>{sourceName(source)}</strong>
                <span>{message}</span>
              </div>
            ))}
          </div>
        )}

        <div className="wl-browse-body">
          <nav className="wl-alpha" aria-label="Jump to letter">
            {'#ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').map((letter) => {
              const enabled = visibleLetters.has(letter);
              return (
                <button
                  key={letter}
                  type="button"
                  className="wl-alpha-key"
                  disabled={!enabled}
                  onClick={() => jumpToLetter(letter)}
                  aria-label={`Jump to ${letter}`}
                >
                  {letter}
                </button>
              );
            })}
          </nav>

          <div className="wl-catalog-scroller" ref={scrollerRef}>
            {groups.length === 0 ? (
              <div className="empty-state lg">
                {catalogStatus === 'loading'
                  ? 'Loading…'
                  : normalizedQuery
                    ? 'No symbols match this search.'
                    : 'No symbols available.'}
              </div>
            ) : (
              groups.map((group) => (
                <div key={group.letter} className="wl-catalog-group" data-letter={group.letter}>
                  <div className="wl-catalog-group-head">
                    <span>{group.letter}</span>
                    <small>{group.items.length}</small>
                  </div>
                  <ul className="wl-catalog-list">
                    {group.items.map((item) => {
                      const busy = busyKey === item.key;
                      return (
                        <li key={item.key} className={`wl-catalog-row ${item.exists ? 'is-active' : ''}`}>
                          <div className="wl-catalog-id">
                            <strong>{item.symbol}</strong>
                            {item.label && item.label !== item.symbol && (
                              <span className="wl-catalog-label">{item.label}</span>
                            )}
                          </div>
                          <span className="wl-catalog-venue">
                            {item.displayText || item.instType || SOURCE_LABEL[searchSource]}
                          </span>
                          <button
                            type="button"
                            className={`wl-catalog-action ${item.exists ? 'is-active' : ''}`}
                            disabled={!editable || item.exists || busy}
                            onClick={() => handleAdd(item)}
                            aria-label={item.exists ? `${item.symbol} is active` : `Add ${item.symbol}`}
                          >
                            {busy ? (
                              <Loader2 size={13} className="spin" />
                            ) : item.exists ? (
                              <Check size={13} />
                            ) : (
                              <Plus size={13} />
                            )}
                            <span>{item.exists ? 'Active' : 'Add'}</span>
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              ))
            )}
          </div>
        </div>

        {status && <div className="wl-status">{status}</div>}
      </section>
    </>
  );
}
