import { useEffect, useRef, useState } from 'react';
import { Settings, X } from 'lucide-react';
import { useMarketStore, useGroups } from '../../stores/marketStore';
import { useUiStore } from '../../stores/uiStore';
import { GROUP_LABELS } from '../../constants';
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
                />
              );
            })}
        </div>
      </aside>
    </div>
  );
}
