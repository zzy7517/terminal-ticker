import { useCallback, useEffect, useRef, useState } from 'react';
import { Check, Plus, Settings, X } from 'lucide-react';
import './WatchlistDrawer.css';
import { useMarketStore, useGroups } from '../../stores/marketStore';
import { useUiStore } from '../../stores/uiStore';
import { GROUP_LABELS } from '../../constants';
import { saveJin10Config, fetchJin10AvailableCodes } from '../../api';
import { WatchlistRow } from './WatchlistRow';

export function WatchlistDrawer() {
  const open = useUiStore((s) => s.watchlistOpen);
  const setOpen = useUiStore((s) => s.setWatchlistOpen);
  const selectedKey = useUiStore((s) => s.selectedKey);
  const setSelectedKey = useUiStore((s) => s.setSelectedKey);
  const activeGroup = useUiStore((s) => s.activeGroup);
  const setActiveGroup = useUiStore((s) => s.setActiveGroup);

  const state = useMarketStore((s) => s.state);
  const groups = useGroups();

  const activeKeys = activeGroup && state ? state.groups[activeGroup] ?? [] : [];
  const leaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Jin10 editing state
  const isJin10Group = activeGroup === 'jin10';
  const [jin10Editing, setJin10Editing] = useState(false);
  const [jin10NewCode, setJin10NewCode] = useState('');
  const [jin10Saving, setJin10Saving] = useState(false);
  const [jin10AvailableCodes, setJin10AvailableCodes] = useState<Array<{ code: string; name: string }>>([]);
  const jin10Codes = state?.config?.jin10?.quotesCodes ?? [];

  // Load available codes from MCP resource when editing
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

  // Keep the DOM mounted during exit transition
  const [mounted, setMounted] = useState(false);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (open) {
      setMounted(true);
      // Trigger the "open" class on next frame so the transition fires
      requestAnimationFrame(() => requestAnimationFrame(() => setVisible(true)));
    } else {
      setVisible(false);
    }
  }, [open]);

  const handleTransitionEnd = () => {
    if (!visible) setMounted(false);
  };

  const handleMouseLeave = () => {
    leaveTimer.current = setTimeout(() => setOpen(false), 400);
  };

  const handleMouseEnter = () => {
    if (leaveTimer.current) {
      clearTimeout(leaveTimer.current);
      leaveTimer.current = null;
    }
  };

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, setOpen]);

  // Global Cmd+B shortcut
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'b') {
        e.preventDefault();
        useUiStore.getState().toggleWatchlist();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  if (!mounted) return null;

  return (
    <div
      className={`watchlist-drawer-backdrop ${visible ? 'open' : ''}`}
      onClick={() => setOpen(false)}
      onTransitionEnd={handleTransitionEnd}
    >
      <aside
        className={`watchlist-drawer ${visible ? 'open' : ''}`}
        onClick={(e) => e.stopPropagation()}
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
      >
        <div className="watchlist-drawer-head">
          <span className="sidebar-title">自选列表</span>
          <div className="watchlist-drawer-actions">
            <button
              aria-label="Manage watchlist"
              className="sidebar-manage-button"
              onClick={() => useUiStore.getState().openSettings('watchlist')}
              type="button"
            >
              <Settings size={14} />
            </button>
            <button
              aria-label="Close watchlist"
              className="sidebar-manage-button"
              onClick={() => setOpen(false)}
              type="button"
            >
              <X size={14} />
            </button>
          </div>
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

        <div className="watchlist-header">
          <span>名称/代码</span>
          <span>最新价</span>
          <span>涨跌幅</span>
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
                  onRemove={isJin10Group ? () => jin10RemoveCode(instrument.symbol) : undefined}
                />
              );
            })}
        </div>

        {isJin10Group && (
          <div className="jin10-watchlist-editor">
            {jin10Editing ? (
              <>
                <div className="jin10-watchlist-add">
                  <input
                    className="input sm"
                    value={jin10NewCode}
                    onChange={(e) => setJin10NewCode(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') { e.preventDefault(); jin10AddCode(jin10NewCode); }
                      if (e.key === 'Escape') { setJin10Editing(false); setJin10NewCode(''); }
                    }}
                    placeholder="输入品种代码回车添加"
                    spellCheck={false}
                    autoFocus
                    disabled={jin10Saving}
                  />
                  <button
                    className="shell-button sm muted"
                    type="button"
                    onClick={() => { setJin10Editing(false); setJin10NewCode(''); }}
                  >
                    <Check size={13} /> 完成
                  </button>
                </div>
                {jin10AvailableCodes.length > 0 && (
                  <div className="jin10-suggestions">
                    {jin10AvailableCodes
                      .filter((item) => !jin10Codes.includes(item.code))
                      .filter((item) => !jin10NewCode || item.code.toUpperCase().includes(jin10NewCode.toUpperCase()) || item.name.includes(jin10NewCode))
                      .slice(0, 20)
                      .map((item) => (
                        <button
                          key={item.code}
                          type="button"
                          className="jin10-suggestion-chip"
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
                className="shell-button sm jin10-add-btn"
                type="button"
                onClick={() => setJin10Editing(true)}
              >
                <Plus size={13} /> 添加品种
              </button>
            )}
          </div>
        )}
      </aside>
    </div>
  );
}
