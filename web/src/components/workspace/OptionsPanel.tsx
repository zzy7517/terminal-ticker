import { useEffect, useMemo, useState } from 'react';
import { useMarketStore } from '../../stores/marketStore';
import './OptionsPanel.css';

// ── Types ────────────────────────────────────────────────────────────────────

interface StrikeGex {
  strike: number;
  callGex: number;
  putGex: number;
  netGex: number;
  callOi: number;
  putOi: number;
}

interface OptionsSnapshot {
  symbol: string;
  spotPrice: number;
  netGexBillions: number;
  regime: 'long_gamma' | 'short_gamma' | 'neutral';
  regimeDescription: string;
  zeroGammaLevel: number;
  callWall: number;
  putWall: number;
  maxGammaStrike: number;
  dominantStrike: number;
  charmFlow: number | null;
  vannaFlow: number | null;
  gexByStrike: StrikeGex[];
  provider: string;
  timestamp: number;
}

interface UnusualItem {
  symbol: string;
  strike: number;
  type: 'call' | 'put';
  expiration: string;
  timestampMs: number;
  oiChange: number;
  volume: number;
  volumeOiRatio: number;
  premiumEstimate: number;
  signal: string;
}

// ── Formatters ───────────────────────────────────────────────────────────────

function fmtBillions(v: number): string {
  return `${v >= 0 ? '+' : ''}${v.toFixed(2)}B`;
}

function fmtMoney(v: number | null): string {
  if (v == null) return '-';
  const abs = Math.abs(v);
  const sign = v >= 0 ? '+' : '-';
  if (abs >= 1e9) return `${sign}$${(abs / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${sign}$${(abs / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `${sign}$${(abs / 1e3).toFixed(0)}K`;
  return `$${v.toFixed(0)}`;
}

function fmtPct(level: number, spot: number): string {
  const pct = ((level - spot) / spot) * 100;
  return `${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%`;
}

function fmtTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

// ── Main Component ───────────────────────────────────────────────────────────

export function OptionsPanel() {
  const state = useMarketStore((s) => s.state);
  const optionsData = (state as any)?.options?.snapshots as Record<string, OptionsSnapshot> | undefined;

  const symbols = useMemo(() => {
    if (!optionsData) return [];
    return Object.keys(optionsData);
  }, [optionsData]);

  const [activeSymbol, setActiveSymbol] = useState<string>('');
  const [unusualActivity, setUnusualActivity] = useState<UnusualItem[]>([]);

  // Auto-select first symbol
  useEffect(() => {
    if (symbols.length > 0 && (!activeSymbol || !symbols.includes(activeSymbol))) {
      setActiveSymbol(symbols[0]);
    }
  }, [symbols, activeSymbol]);

  // Fetch unusual activity
  useEffect(() => {
    if (!activeSymbol) return;
    fetch(`/api/options/unusual?symbol=${activeSymbol}&limit=20`)
      .then((r) => r.ok ? r.json() : null)
      .then((data) => { if (data?.items) setUnusualActivity(data.items); })
      .catch(() => {});
  }, [activeSymbol]);

  // ── Empty state ──
  if (!optionsData || symbols.length === 0) {
    return (
      <div className="options-panel__empty">
        <span>Options & GEX Analysis</span>
        <span>No data available. Enable options in Settings or wait for first poll.</span>
        <code>[options] enabled = true</code>
      </div>
    );
  }

  const snap = optionsData[activeSymbol];
  if (!snap) return null;

  return (
    <div className="options-panel">
      {/* Symbol Tabs */}
      <div className="options-panel__tabs">
        {symbols.map((sym) => (
          <button
            key={sym}
            className={`options-panel__tab${activeSymbol === sym ? ' active' : ''}`}
            type="button"
            onClick={() => setActiveSymbol(sym)}
          >
            {sym}
          </button>
        ))}
        <span className="options-panel__tab-meta">
          {snap.provider} - {fmtTime(snap.timestamp)}
        </span>
      </div>

      {/* Overview Stats */}
      <div className="options-stats">
        <Stat
          label="Net GEX"
          value={fmtBillions(snap.netGexBillions)}
          className={snap.netGexBillions >= 0 ? 'positive' : 'negative'}
        />
        <Stat
          label="Regime"
          value={snap.regime.replace('_', ' ')}
          className={snap.regime === 'long_gamma' ? 'positive' : snap.regime === 'short_gamma' ? 'negative' : 'warning'}
          sub={snap.regimeDescription}
        />
        <Stat label="Spot" value={snap.spotPrice.toFixed(2)} className="accent" />
        <Stat
          label="Zero Gamma"
          value={snap.zeroGammaLevel.toFixed(1)}
          sub={fmtPct(snap.zeroGammaLevel, snap.spotPrice)}
        />
        <Stat
          label="Charm Flow"
          value={fmtMoney(snap.charmFlow)}
          className={snap.charmFlow != null ? (snap.charmFlow >= 0 ? 'positive' : 'negative') : undefined}
        />
        <Stat
          label="Vanna Flow"
          value={fmtMoney(snap.vannaFlow)}
          className={snap.vannaFlow != null ? (snap.vannaFlow >= 0 ? 'positive' : 'negative') : undefined}
        />
      </div>

      {/* Key Levels Visual */}
      <KeyLevelsBar snap={snap} />

      {/* GEX by Strike Profile */}
      <GexProfile strikes={snap.gexByStrike} spotPrice={snap.spotPrice} zgl={snap.zeroGammaLevel} />

      {/* Unusual Activity */}
      {unusualActivity.length > 0 && (
        <div className="options-activity">
          <div className="options-activity__title">Unusual Activity</div>
          <div className="options-activity__list">
            {unusualActivity.map((item, i) => (
              <div key={i} className="options-activity__item">
                <span className={`options-activity__signal ${item.signal}`}>{item.signal}</span>
                <span className={`options-activity__type ${item.type}`}>{item.type.toUpperCase()}</span>
                <span className="options-activity__detail">
                  {item.strike} {item.expiration} | Vol:{item.volume.toLocaleString()} OI:{Math.abs(item.oiChange).toLocaleString()}
                </span>
                <span className="options-activity__premium">{fmtMoney(item.premiumEstimate)}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Sub-Components ───────────────────────────────────────────────────────────

function Stat({ label, value, className, sub }: { label: string; value: string; className?: string; sub?: string }) {
  return (
    <div className="options-stat">
      <span className="options-stat__label">{label}</span>
      <span className={`options-stat__value${className ? ` ${className}` : ''}`}>{value}</span>
      {sub && <span className="options-stat__sub">{sub}</span>}
    </div>
  );
}

function KeyLevelsBar({ snap }: { snap: OptionsSnapshot }) {
  const levels = [
    { label: 'Put Wall', value: snap.putWall, color: 'var(--down)' },
    { label: 'ZGL', value: snap.zeroGammaLevel, color: 'var(--warning)' },
    { label: 'Spot', value: snap.spotPrice, color: 'var(--accent)' },
    { label: 'Max Gamma', value: snap.maxGammaStrike, color: '#a855f7' },
    { label: 'Call Wall', value: snap.callWall, color: 'var(--up)' },
  ];

  // Calculate positions as % of range
  const allValues = levels.map((l) => l.value).filter((v) => v > 0);
  const min = Math.min(...allValues) * 0.998;
  const max = Math.max(...allValues) * 1.002;
  const range = max - min || 1;

  return (
    <div className="options-levels">
      <div className="options-levels__title">Key Levels</div>
      <div className="options-levels__bar">
        <div className="options-levels__track" />
        {levels.map((l) => {
          if (l.value <= 0) return null;
          const pct = ((l.value - min) / range) * 100;
          return (
            <div
              key={l.label}
              className="options-levels__marker"
              style={{ left: `${Math.max(2, Math.min(98, pct))}%` }}
            >
              <div className="options-levels__marker-dot" style={{ background: l.color }} />
              <span className="options-levels__marker-label" style={{ color: l.color }}>
                {l.value.toFixed(0)}
              </span>
            </div>
          );
        })}
      </div>
      <div className="options-levels__legend">
        {levels.map((l) => (
          <span key={l.label} className="options-levels__legend-item">
            <span className="options-levels__legend-dot" style={{ background: l.color }} />
            {l.label} ({fmtPct(l.value, snap.spotPrice)})
          </span>
        ))}
      </div>
    </div>
  );
}

function GexProfile({ strikes, spotPrice, zgl }: { strikes: StrikeGex[]; spotPrice: number; zgl: number }) {
  if (!strikes || strikes.length === 0) {
    return (
      <div className="gex-profile">
        <div className="gex-profile__title">GEX Profile</div>
        <div style={{ color: 'var(--text-muted)', fontSize: 11, padding: '8px 0' }}>Waiting for data...</div>
      </div>
    );
  }

  const maxGex = Math.max(...strikes.map((s) => Math.max(Math.abs(s.callGex), Math.abs(s.putGex))), 1);

  return (
    <div className="gex-profile">
      <div className="gex-profile__head">
        <span className="gex-profile__title">GEX by Strike</span>
        <div className="gex-profile__legend">
          <span className="gex-profile__legend-item">
            <span className="gex-profile__legend-swatch" style={{ background: 'var(--down)' }} />
            Put
          </span>
          <span className="gex-profile__legend-item">
            <span className="gex-profile__legend-swatch" style={{ background: 'var(--up)' }} />
            Call
          </span>
        </div>
      </div>

      <div className="gex-profile__chart">
        {strikes.map((s) => {
          const isSpot = Math.abs(s.strike - spotPrice) < spotPrice * 0.005;
          const isZgl = Math.abs(s.strike - zgl) < spotPrice * 0.005;
          const callPct = (Math.abs(s.callGex) / maxGex) * 100;
          const putPct = (Math.abs(s.putGex) / maxGex) * 100;

          return (
            <div
              key={s.strike}
              className={`gex-profile__row${isSpot ? ' is-spot' : ''}${isZgl ? ' is-zgl' : ''}`}
            >
              <span className="gex-profile__strike">
                {s.strike.toFixed(0)}{isSpot ? ' \u25C0' : isZgl ? ' \u25C6' : ''}
              </span>
              <div className="gex-profile__bars">
                <div className="gex-profile__center" />
                <div className="gex-profile__bar-left">
                  <div className="gex-profile__bar-fill put" style={{ width: `${putPct}%` }} />
                </div>
                <div className="gex-profile__bar-right">
                  <div className="gex-profile__bar-fill call" style={{ width: `${callPct}%` }} />
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
