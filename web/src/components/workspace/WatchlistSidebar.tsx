import { useCallback, useEffect, useRef, useState } from 'react';
import { Check, ChevronLeft, ChevronRight, Plus, Settings, X } from 'lucide-react';
import './WatchlistSidebar.css';
import { useMarketStore, useGroups } from '../../stores/marketStore';
import { useUiStore } from '../../stores/uiStore';
import { GROUP_LABELS } from '../../constants';
import { changeClass } from '../../utils';
import { saveJin10Config, fetchJin10AvailableCodes, reorderWatchlist, removeWatchlistInstrument } from '../../api';
import type { Instrument, Quote } from '../../types';

function SidebarRow({
  instrument,
  quote,
  selected,
  onSelect,
  onRemove,
  collapsed,
  dragging,
  dragOver,
  onDragStart,
  onDragEnd,
  onDragOver,
  onDragLeave,
  onDrop,
}: {
  instrument: Instrument;
  quote: Quote | undefined;
  selected: boolean;
  onSelect: () => void;
  onRemove?: () => void;
  collapsed: boolean;
  dragging: boolean;
  dragOver: 'above' | 'below' | null;
  onDragStart: (e: React.DragEvent) => void;
  onDragEnd: (e: React.DragEvent) => void;
  onDragOver: (e: React.DragEvent) => void;
  onDragLeave: () => void;
  onDrop: (e: React.DragEvent) => void;
}) {
  if (collapsed) {
    const cls = changeClass(quote);
    return (
      <div
        className={`sb-row sb-row--collapsed ${selected ? 'selected' : ''} ${dragging ? 'sb-dragging' : ''} ${dragOver ? `sb-drag-${dragOver}` : ''}`}
        draggable
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
        onClick={onSelect}
        title={`${instrument.label} ${quote?.percentLabel ?? ''}`}
      >
        <span className="sb-row-sym">{instrument.symbol.slice(0, 4)}</span>
        <span className={`sb-row-collapsed-price ${cls}`}>
          {quote?.priceLabel ?? '—'}
        </span>
      </div>
    );
  }

  return (
    <div
      className={`sb-row ${selected ? 'selected' : ''} ${dragging ? 'sb-dragging' : ''} ${dragOver ? `sb-drag-${dragOver}` : ''}`}
      draggable
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      onClick={onSelect}
    >
      <div className="sb-row-left">
        <span className="sb-row-label">{instrument.label}</span>
        <span className="sb-row-code">{instrument.symbol}</span>
      </div>
      <div className="sb-row-right">
        <span className="sb-row-price">{quote?.priceLabel ?? '\u2014'}</span>
        <span className={`sb-row-change ${changeClass(quote)}`}>
          {quote?.percentLabel ?? '\u2014'}
        </span>
      </div>
      {onRemove && (
        <span
          className="sb-row-remove"
          role="button"
          tabIndex={-1}
          onClick={(e) => { e.stopPropagation(); onRemove(); }}
          title="\u79fb\u9664"
        >
          <X size={11} />
        </span>
      )}
    </div>
  );
}

export function WatchlistSidebar() {
  const selectedKey = useUiStore((s) => s.selectedKey);
  const setSelectedKey = useUiStore((s) => s.setSelectedKey);
  const activeGroup = useUiStore((s) => s.activeGroup);
  const setActiveGroup = useUiStore((s) => s.setActiveGroup);

  const state = useMarketStore((s) => s.state);
  const groups = useGroups();

  // Sidebar collapsed state (persisted in localStorage)
  const [collapsed, setCollapsed] = useState(() => {
    try { return window.localStorage.getItem('tradex_sidebar_collapsed') === '1'; } catch { return false; }
  });

  // When collapsed, show ALL instruments across all groups for a full-market overview
  const activeKeys = collapsed && state
    ? state.instruments.map((i) => i.key)
    : (activeGroup && state ? state.groups[activeGroup] ?? [] : []);

  const toggleCollapse = useCallback(() => {
    setCollapsed((prev) => {
      const next = !prev;
      try { window.localStorage.setItem('tradex_sidebar_collapsed', next ? '1' : '0'); } catch {}
      return next;
    });
  }, []);

  // ── Drag-and-drop state ────────────────────────────────────────────────────
  const [dragKey, setDragKey] = useState<string | null>(null);
  const [dragOverKey, setDragOverKey] = useState<string | null>(null);
  const [dragOverPos, setDragOverPos] = useState<'above' | 'below' | null>(null);
  const [localOrder, setLocalOrder] = useState<string[] | null>(null);
  const reorderTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingReorder = useRef(false);

  // Use localOrder for optimistic display, fall back to server state
  const displayKeys = localOrder ?? activeKeys;

  const handleDragStart = useCallback((key: string) => (e: React.DragEvent) => {
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', key);
    setDragKey(key);
  }, []);

  const handleDragEnd = useCallback(() => {
    setDragKey(null);
    setDragOverKey(null);
    setDragOverPos(null);
  }, []);

  const handleDragOver = useCallback((key: string) => (e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (!dragKey || dragKey === key) {
      setDragOverKey(null);
      setDragOverPos(null);
      return;
    }
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const midY = rect.top + rect.height / 2;
    const pos = e.clientY < midY ? 'above' : 'below';
    setDragOverKey(key);
    setDragOverPos(pos);
  }, [dragKey]);

  const handleDragLeave = useCallback((key: string) => () => {
    setDragOverKey((prev) => prev === key ? null : prev);
  }, []);

  const handleDrop = useCallback((targetKey: string) => (e: React.DragEvent) => {
    e.preventDefault();
    const sourceKey = e.dataTransfer.getData('text/plain');
    if (!sourceKey || sourceKey === targetKey) {
      handleDragEnd();
      return;
    }

    // Compute new order
    const currentOrder = [...(localOrder ?? activeKeys)];
    const sourceIdx = currentOrder.indexOf(sourceKey);
    if (sourceIdx < 0) { handleDragEnd(); return; }

    // Remove source from current position
    currentOrder.splice(sourceIdx, 1);

    // Find target position
    let targetIdx = currentOrder.indexOf(targetKey);
    if (targetIdx < 0) { handleDragEnd(); return; }

    // Determine if cursor was in upper or lower half
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const midY = rect.top + rect.height / 2;
    const insertAfter = e.clientY >= midY;

    if (insertAfter) {
      targetIdx += 1;
    }

    currentOrder.splice(targetIdx, 0, sourceKey);

    // Optimistic local update
    setLocalOrder(currentOrder);
    pendingReorder.current = true;
    handleDragEnd();

    // Debounced API call
    if (reorderTimeout.current) clearTimeout(reorderTimeout.current);
    reorderTimeout.current = setTimeout(() => {
      reorderWatchlist(currentOrder)
        .then((nextState) => {
          useMarketStore.getState().setState(nextState);
          setLocalOrder(null);
          pendingReorder.current = false;
        })
        .catch(() => {
          setLocalOrder(null);
          pendingReorder.current = false;
        });
    }, 300);
  }, [activeKeys, localOrder, handleDragEnd]);

  // Reset local order when group changes (but NOT when server keys change from our own reorder)
  useEffect(() => {
    setLocalOrder(null);
  }, [activeGroup]);

  // When server keys update, only reset localOrder if we're not mid-reorder
  const activeKeysSig = activeKeys.join(',');
  useEffect(() => {
    if (!pendingReorder.current) {
      setLocalOrder(null);
    }
  }, [activeKeysSig]);

  // Jin10 editing state
  const isJin10Group = activeGroup === 'jin10';
  const [jin10Editing, setJin10Editing] = useState(false);
  const [jin10NewCode, setJin10NewCode] = useState('');
  const [jin10Saving, setJin10Saving] = useState(false);
  const [jin10AvailableCodes, setJin10AvailableCodes] = useState<Array<{ code: string; name: string }>>([]);
  const jin10Codes = state?.config?.jin10?.quotesCodes ?? [];

  useEffect(() => {
    if (jin10Editing && jin10AvailableCodes.length === 0) {
      fetchJin10AvailableCodes().then((res) => {
        if (res.codes.length > 0) setJin10AvailableCodes(res.codes);
      }).catch(() => {});
    }
  }, [jin10Editing, jin10AvailableCodes.length]);

  const jin10RemoveCode = useCallback(async (code: string) => {
    const next = jin10Codes.filter((c) => c !== code);
    setJin10Saving(true);
    try {
      const nextState = await saveJin10Config({ quotes_codes: next });
      useMarketStore.getState().setState(nextState);
    } catch { /* ignore */ }
    finally { setJin10Saving(false); }
  }, [jin10Codes]);

  const jin10AddCode = useCallback(async (code: string) => {
    const normalized = code.trim().toUpperCase();
    if (!normalized || jin10Codes.includes(normalized)) return;
    const next = [...jin10Codes, normalized];
    setJin10Saving(true);
    setJin10NewCode('');
    try {
      const nextState = await saveJin10Config({ quotes_codes: next });
      useMarketStore.getState().setState(nextState);
    } catch { /* ignore */ }
    finally { setJin10Saving(false); }
  }, [jin10Codes]);

  // Unified remove handler for all instrument sources
  const handleRemove = useCallback(async (key: string, instrument: Instrument) => {
    try {
      if (instrument.source === 'jin10') {
        await jin10RemoveCode(instrument.symbol);
      } else {
        const nextState = await removeWatchlistInstrument(key);
        useMarketStore.getState().setState(nextState);
      }
    } catch { /* ignore */ }
  }, [jin10RemoveCode]);

  // Global Cmd+B shortcut to toggle collapse
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'b') {
        e.preventDefault();
        toggleCollapse();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [toggleCollapse]);

  return (
    <aside className={`watchlist-sidebar ${collapsed ? 'collapsed' : ''}`}>
      {/* Header */}
      <div className="sb-head">
        {!collapsed && <span className="sb-title">{'\u884c\u60c5'}</span>}
        <div className="sb-head-actions">
          {!collapsed && (
            <button
              aria-label="Manage watchlist"
              className="sb-icon-btn"
              onClick={() => useUiStore.getState().openSettings('watchlist')}
              type="button"
              title={'\u7ba1\u7406\u81ea\u9009'}
            >
              <Settings size={13} />
            </button>
          )}
          <button
            aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            className="sb-icon-btn"
            onClick={toggleCollapse}
            type="button"
            title={collapsed ? '\u5c55\u5f00 (\u2318B)' : '\u6536\u8d77 (\u2318B)'}
          >
            {collapsed ? <ChevronRight size={14} /> : <ChevronLeft size={14} />}
          </button>
        </div>
      </div>

      {/* Group tabs */}
      {!collapsed && (
        <div className="sb-groups">
          {groups.map((group) => (
            <button
              className={`sb-group-btn ${group === activeGroup ? 'active' : ''}`}
              key={group}
              type="button"
              onClick={() => setActiveGroup(group)}
              title={GROUP_LABELS[group] ?? group}
            >
              {GROUP_LABELS[group] ?? group}
            </button>
          ))}
        </div>
      )}

      {/* Instrument list */}
      <div className="sb-list">
        {state &&
          displayKeys.map((key) => {
            const instrument = state.instruments.find((item) => item.key === key);
            if (!instrument) return null;
            return (
              <SidebarRow
                key={key}
                instrument={instrument}
                quote={state.quotes[key]}
                selected={selectedKey === key}
                onSelect={() => setSelectedKey(key)}
                onRemove={!collapsed ? () => handleRemove(key, instrument) : undefined}
                collapsed={collapsed}
                dragging={dragKey === key}
                dragOver={dragOverKey === key ? dragOverPos : null}
                onDragStart={handleDragStart(key)}
                onDragEnd={handleDragEnd}
                onDragOver={handleDragOver(key)}
                onDragLeave={handleDragLeave(key)}
                onDrop={handleDrop(key)}
              />
            );
          })}
      </div>

      {/* Jin10 editor (only when expanded) */}
      {isJin10Group && !collapsed && (
        <div className="sb-jin10-editor">
          {jin10Editing ? (
            <>
              <div className="sb-jin10-add">
                <input
                  className="input sm"
                  value={jin10NewCode}
                  onChange={(e) => setJin10NewCode(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') { e.preventDefault(); jin10AddCode(jin10NewCode); }
                    if (e.key === 'Escape') { setJin10Editing(false); setJin10NewCode(''); }
                  }}
                  placeholder={'\u4ee3\u7801\u56de\u8f66\u6dfb\u52a0'}
                  spellCheck={false}
                  autoFocus
                  disabled={jin10Saving}
                />
                <button
                  className="sb-icon-btn"
                  type="button"
                  onClick={() => { setJin10Editing(false); setJin10NewCode(''); }}
                  title="完成"
                >
                  <Check size={12} />
                </button>
              </div>
              {jin10AvailableCodes.length > 0 && (
                <div className="sb-jin10-suggestions">
                  {jin10AvailableCodes
                    .filter((item) => !jin10Codes.includes(item.code))
                    .filter((item) => !jin10NewCode || item.code.toUpperCase().includes(jin10NewCode.toUpperCase()) || item.name.includes(jin10NewCode))
                    .slice(0, 12)
                    .map((item) => (
                      <button
                        key={item.code}
                        type="button"
                        className="sb-jin10-chip"
                        onClick={() => jin10AddCode(item.code)}
                        disabled={jin10Saving}
                        title={item.code}
                      >
                        {item.name}
                      </button>
                    ))}
                </div>
              )}
            </>
          ) : (
            <button
              className="sb-icon-btn sb-add-btn"
              type="button"
              onClick={() => setJin10Editing(true)}
              title="添加品种"
            >
              <Plus size={12} />
              <span>添加</span>
            </button>
          )}
        </div>
      )}
    </aside>
  );
}