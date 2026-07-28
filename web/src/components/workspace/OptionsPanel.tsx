import { useEffect, useMemo, useState } from 'react';
import { useMarketStore } from '../../stores/marketStore';
import { Reveal } from '../Reveal';
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

interface RegimeParams {
  atmIV: number;
  regime: 'calm' | 'normal' | 'stressed' | 'crisis';
  impliedSpotVolCorr: number;
  impliedVolOfVol: number;
  expectedDailySpotMove: number;
}

interface ImpulsePoint {
  price: number;
  impulse: number;
}

interface HedgeImpulse {
  regime: 'pinned' | 'expansion' | 'squeeze-up' | 'squeeze-down' | 'neutral';
  impulseAtSpot: number;
  nearestAttractorAbove: number | null;
  nearestAttractorBelow: number | null;
  asymmetry: { upside: number; downside: number; bias: 'up' | 'down' | 'neutral'; asymmetryRatio: number };
  curve: ImpulsePoint[];
}

interface PressureZone {
  center: number;
  lower: number;
  upper: number;
  strength: number;
  side: 'above-spot' | 'below-spot';
  tradeType: 'long' | 'short';
  hedgeType: 'passive' | 'aggressive';
}

interface PressureCloud {
  stabilityZones: PressureZone[];
  accelerationZones: PressureZone[];
  regimeEdges: { price: number; transitionType: string }[];
}

interface IVSurface {
  expiration: string;
  strikes: number[];
  smoothedIVs: number[];
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
  // Advanced analytics (A modules)
  regimeParams: RegimeParams | null;
  ivSurface: IVSurface | null;
  hedgeImpulse: HedgeImpulse | null;
  pressureCloud: PressureCloud | null;
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

      {/* Market Regime + Hedge Impulse summary */}
      {(snap.regimeParams || snap.hedgeImpulse) && (
        <RegimeImpulseRow snap={snap} />
      )}

      {/* Key Levels Visual */}
      <KeyLevelsBar snap={snap} />

      {/* Hedge Impulse Curve */}
      {snap.hedgeImpulse && snap.hedgeImpulse.curve.length > 1 && (
        <ImpulseCurve impulse={snap.hedgeImpulse} spotPrice={snap.spotPrice} />
      )}

      {/* Pressure Cloud zones */}
      {snap.pressureCloud && (
        <PressureCloudView cloud={snap.pressureCloud} spotPrice={snap.spotPrice} />
      )}

      {/* GEX by Strike Profile */}
      <GexProfile strikes={snap.gexByStrike} spotPrice={snap.spotPrice} zgl={snap.zeroGammaLevel} />

      {/* Unusual Activity */}
      {unusualActivity.length > 0 && (
        <Reveal className="options-activity ui-surface" index={3}>
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
        </Reveal>
      )}
    </div>
  );
}

// ── Sub-Components ───────────────────────────────────────────────────────────

function Stat({ label, value, className, sub }: { label: string; value: string; className?: string; sub?: string }) {
  return (
    <div className="options-stat ui-surface">
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
    <Reveal className="options-levels ui-surface" index={1}>
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
    </Reveal>
  );
}

function GexProfile({ strikes, spotPrice, zgl }: { strikes: StrikeGex[]; spotPrice: number; zgl: number }) {
  if (!strikes || strikes.length === 0) {
    return (
      <Reveal className="gex-profile ui-surface" index={2}>
        <div className="gex-profile__title">GEX Profile</div>
        <div className="empty-state sm">Waiting for the first options poll.</div>
      </Reveal>
    );
  }

  const maxGex = Math.max(...strikes.map((s) => Math.max(Math.abs(s.callGex), Math.abs(s.putGex))), 1);

  return (
    <Reveal className="gex-profile ui-surface" index={2}>
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
                  <div
                    className="gex-profile__bar-fill put"
                    style={{ transform: `scaleX(${putPct / 100})` }}
                  />
                </div>
                <div className="gex-profile__bar-right">
                  <div
                    className="gex-profile__bar-fill call"
                    style={{ transform: `scaleX(${callPct / 100})` }}
                  />
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </Reveal>
  );
}

const IMPULSE_REGIME_LABEL: Record<string, string> = {
  pinned: 'Pinned',
  expansion: 'Expansion',
  'squeeze-up': 'Squeeze Up',
  'squeeze-down': 'Squeeze Down',
  neutral: 'Neutral',
};

const IMPULSE_REGIME_CLASS: Record<string, string> = {
  pinned: 'positive',
  expansion: 'negative',
  'squeeze-up': 'positive',
  'squeeze-down': 'negative',
  neutral: 'warning',
};

function RegimeImpulseRow({ snap }: { snap: OptionsSnapshot }) {
  const rp = snap.regimeParams;
  const hi = snap.hedgeImpulse;
  return (
    <div className="options-stats">
      {rp && (
        <Stat
          label="Vol Regime"
          value={rp.regime}
          className={rp.regime === 'calm' || rp.regime === 'normal' ? 'positive' : 'negative'}
          sub={`ATM IV ${(rp.atmIV * 100).toFixed(1)}%`}
        />
      )}
      {rp && (
        <Stat
          label="Exp. Daily Move"
          value={`\u00B1${(rp.expectedDailySpotMove * 100).toFixed(2)}%`}
          sub={`spot-vol corr ${rp.impliedSpotVolCorr.toFixed(2)}`}
        />
      )}
      {hi && (
        <Stat
          label="Impulse Regime"
          value={IMPULSE_REGIME_LABEL[hi.regime] ?? hi.regime}
          className={IMPULSE_REGIME_CLASS[hi.regime]}
          sub={`bias ${hi.asymmetry.bias}`}
        />
      )}
      {hi && (
        <Stat
          label="Attractors"
          value={`${hi.nearestAttractorBelow ? hi.nearestAttractorBelow.toFixed(0) : '\u2013'} / ${hi.nearestAttractorAbove ? hi.nearestAttractorAbove.toFixed(0) : '\u2013'}`}
          sub="below / above"
        />
      )}
    </div>
  );
}

function ImpulseCurve({ impulse, spotPrice }: { impulse: HedgeImpulse; spotPrice: number }) {
  const pts = impulse.curve;
  const W = 100;
  const H = 40;
  const prices = pts.map((p) => p.price);
  const impulses = pts.map((p) => p.impulse);
  const minP = Math.min(...prices);
  const maxP = Math.max(...prices);
  const rangeP = maxP - minP || 1;
  const maxAbs = Math.max(...impulses.map((v) => Math.abs(v)), 1);

  const x = (price: number) => ((price - minP) / rangeP) * W;
  const y = (imp: number) => H / 2 - (imp / maxAbs) * (H / 2 - 2);

  const path = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(p.price).toFixed(2)},${y(p.impulse).toFixed(2)}`).join(' ');
  const spotX = x(Math.max(minP, Math.min(maxP, spotPrice)));

  return (
    <Reveal className="gex-profile ui-surface" index={2}>
      <div className="gex-profile__head">
        <span className="gex-profile__title">Hedge Impulse Curve</span>
        <span className="options-panel__tab-meta">+ = pin / attractor · − = accelerate</span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={{ width: '100%', height: 80, display: 'block' }}>
        <line x1={0} y1={H / 2} x2={W} y2={H / 2} stroke="var(--line-strong)" strokeWidth={0.3} />
        <line x1={spotX} y1={0} x2={spotX} y2={H} stroke="var(--accent)" strokeWidth={0.4} strokeDasharray="1,1" />
        <path d={path} fill="none" stroke="var(--warning)" strokeWidth={0.8} vectorEffect="non-scaling-stroke" />
      </svg>
      <div className="options-levels__legend">
        <span className="options-levels__legend-item">{minP.toFixed(0)}</span>
        <span className="options-levels__legend-item" style={{ marginLeft: 'auto' }}>{maxP.toFixed(0)}</span>
      </div>
    </Reveal>
  );
}

function PressureCloudView({ cloud, spotPrice }: { cloud: PressureCloud; spotPrice: number }) {
  const zones = [
    ...cloud.stabilityZones.map((z) => ({ ...z, kind: 'stability' as const })),
    ...cloud.accelerationZones.map((z) => ({ ...z, kind: 'acceleration' as const })),
  ].sort((a, b) => b.center - a.center);

  if (zones.length === 0) return null;

  return (
    <Reveal className="options-activity ui-surface" index={3}>
      <div className="options-activity__title">Pressure Cloud</div>
      <div className="options-activity__list">
        {zones.map((z, i) => {
          const dist = ((z.center - spotPrice) / spotPrice) * 100;
          return (
            <div key={i} className="options-activity__item">
              <span
                className={`options-activity__signal ${z.kind === 'stability' ? 'opening' : 'sweep'}`}
              >
                {z.kind === 'stability' ? 'STABLE' : 'ACCEL'}
              </span>
              <span className={`options-activity__type ${z.tradeType === 'long' ? 'call' : 'put'}`}>
                {z.tradeType.toUpperCase()}
              </span>
              <span className="options-activity__detail">
                {z.lower.toFixed(0)}–{z.upper.toFixed(0)} ({dist >= 0 ? '+' : ''}{dist.toFixed(1)}%) · {z.hedgeType}
              </span>
              <span className="options-activity__premium">{(z.strength * 100).toFixed(0)}%</span>
            </div>
          );
        })}
        {cloud.regimeEdges.length > 0 && (
          <div className="options-activity__item" style={{ opacity: 0.7 }}>
            <span className="options-activity__signal">EDGE</span>
            <span className="options-activity__detail">
              Regime flips at {cloud.regimeEdges.map((e) => e.price.toFixed(0)).join(', ')}
            </span>
          </div>
        )}
      </div>
    </Reveal>
  );
}
