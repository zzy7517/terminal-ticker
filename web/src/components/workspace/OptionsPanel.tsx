import { useEffect, useMemo, useState } from 'react';
import { useMarketStore } from '../../stores/marketStore';
import type {
  OptionsHedgeImpulse,
  OptionsPressureCloud,
  OptionsSnapshot,
  OptionsStrikeGex,
} from '../../types/market';
import { buildKeyLevels, hasPressureContent } from './optionsKeyLevels';
import './OptionsPanel.css';

// ── Formatters ───────────────────────────────────────────────────────────────

function fmtBillions(v: number): string {
  return `${v >= 0 ? '+' : ''}${v.toFixed(2)}B`;
}

function fmtMoney(v: number | null): string {
  if (v == null) return '—';
  const abs = Math.abs(v);
  const sign = v >= 0 ? '+' : '-';
  if (abs >= 1e9) return `${sign}$${(abs / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${sign}$${(abs / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `${sign}$${(abs / 1e3).toFixed(0)}K`;
  return `${sign}$${abs.toFixed(0)}`;
}

function fmtGexCompact(v: number): string {
  const abs = Math.abs(v);
  const sign = v >= 0 ? '+' : '-';
  if (abs >= 1e9) return `${sign}${(abs / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${sign}${(abs / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `${sign}${(abs / 1e3).toFixed(0)}K`;
  return `${sign}${abs.toFixed(0)}`;
}

function fmtPct(level: number, spot: number): string {
  if (!spot) return '—';
  const pct = ((level - spot) / spot) * 100;
  return `${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%`;
}

function fmtTime(ts: number): string {
  return new Date(ts).toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
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

// ── Main Component ───────────────────────────────────────────────────────────

export function OptionsPanel() {
  const state = useMarketStore((s) => s.state);
  const optionsData = state?.options?.snapshots;

  const symbols = useMemo(() => {
    if (!optionsData) return [];
    return Object.keys(optionsData);
  }, [optionsData]);

  const [activeSymbol, setActiveSymbol] = useState('');

  useEffect(() => {
    if (symbols.length > 0 && (!activeSymbol || !symbols.includes(activeSymbol))) {
      setActiveSymbol(symbols[0]);
    }
  }, [symbols, activeSymbol]);

  // Prefer the selected tab; fall back immediately so the first paint is not blank.
  const resolvedSymbol = symbols.includes(activeSymbol) ? activeSymbol : (symbols[0] ?? '');
  const snap = resolvedSymbol && optionsData ? optionsData[resolvedSymbol] : undefined;

  if (!optionsData || symbols.length === 0 || !snap) {
    return (
      <div className="options-panel__empty">
        <span>Options & GEX</span>
        <span>No snapshot yet. Enable options in Settings, then wait for the first refresh.</span>
        <code>[options] enabled = true</code>
      </div>
    );
  }

  const showImpulse = Boolean(snap.hedgeImpulse && snap.hedgeImpulse.curve.length > 1);
  const showPressure = hasPressureContent(snap.pressureCloud);
  const showSecondary = showImpulse || showPressure;

  return (
    <div className="options-panel">
      <div className="options-panel__header">
        <div className="options-panel__tabs" role="tablist" aria-label="Options symbols">
          {symbols.map((sym) => (
            <button
              key={sym}
              className={`options-panel__tab${resolvedSymbol === sym ? ' active' : ''}`}
              type="button"
              role="tab"
              aria-selected={resolvedSymbol === sym}
              onClick={() => setActiveSymbol(sym)}
            >
              {sym}
            </button>
          ))}
        </div>
        <span className="options-panel__meta">
          {snap.provider} · {fmtTime(snap.timestamp)}
        </span>
      </div>

      <KpiStrip snap={snap} />

      <div className="options-panel__stage">
        <GexProfile
          strikes={snap.gexByStrike}
          spotPrice={snap.spotPrice}
          zgl={snap.zeroGammaLevel}
        />
        <KeyLevelsRail snap={snap} />
      </div>

      {showSecondary && (
        <div className="options-panel__secondary">
          {showImpulse && snap.hedgeImpulse && (
            <ImpulseCurve impulse={snap.hedgeImpulse} spotPrice={snap.spotPrice} />
          )}
          {showPressure && snap.pressureCloud && (
            <PressureBands cloud={snap.pressureCloud} spotPrice={snap.spotPrice} />
          )}
        </div>
      )}

      {snap.regimeDescription && (
        <p className="options-panel__footnote">{snap.regimeDescription}</p>
      )}
    </div>
  );
}

// ── Sub-Components ───────────────────────────────────────────────────────────

function KpiStrip({ snap }: { snap: OptionsSnapshot }) {
  const rp = snap.regimeParams;
  const hi = snap.hedgeImpulse;

  return (
    <div className="options-kpi">
      <Stat
        label="Net GEX"
        value={fmtBillions(snap.netGexBillions)}
        className={snap.netGexBillions >= 0 ? 'positive' : 'negative'}
      />
      <Stat
        label="Regime"
        value={snap.regime.replace('_', ' ')}
        className={
          snap.regime === 'long_gamma'
            ? 'positive'
            : snap.regime === 'short_gamma'
              ? 'negative'
              : 'warning'
        }
      />
      <Stat label="Spot" value={snap.spotPrice.toFixed(2)} className="accent" />
      <Stat
        label="Zero Gamma"
        value={snap.zeroGammaLevel.toFixed(1)}
        sub={fmtPct(snap.zeroGammaLevel, snap.spotPrice)}
      />
      <Stat
        label="Charm"
        value={fmtMoney(snap.charmFlow)}
        className={
          snap.charmFlow != null ? (snap.charmFlow >= 0 ? 'positive' : 'negative') : undefined
        }
      />
      <Stat
        label="Vanna"
        value={fmtMoney(snap.vannaFlow)}
        className={
          snap.vannaFlow != null ? (snap.vannaFlow >= 0 ? 'positive' : 'negative') : undefined
        }
      />
      {rp && (
        <Stat
          label="Vol Regime"
          value={rp.regime}
          className={rp.regime === 'calm' || rp.regime === 'normal' ? 'positive' : 'negative'}
          sub={`ATM ${(rp.atmIV * 100).toFixed(1)}% · ±${(rp.expectedDailySpotMove * 100).toFixed(2)}%`}
        />
      )}
      {hi && (
        <Stat
          label="Impulse"
          value={IMPULSE_REGIME_LABEL[hi.regime] ?? hi.regime}
          className={IMPULSE_REGIME_CLASS[hi.regime]}
          sub={`bias ${hi.asymmetry.bias}`}
        />
      )}
    </div>
  );
}

function Stat({
  label,
  value,
  className,
  sub,
}: {
  label: string;
  value: string;
  className?: string;
  sub?: string;
}) {
  return (
    <div className="options-kpi__item">
      <span className="options-kpi__label">{label}</span>
      <span className={`options-kpi__value${className ? ` ${className}` : ''}`}>{value}</span>
      {sub && <span className="options-kpi__sub">{sub}</span>}
    </div>
  );
}

function KeyLevelsRail({ snap }: { snap: OptionsSnapshot }) {
  const levels = buildKeyLevels(snap);

  if (levels.length === 0) {
    return (
      <div className="options-rail">
        <div className="options-rail__head">
          <span className="options-rail__title">Key Levels</span>
        </div>
        <div className="gex-profile__empty">No key levels in this snapshot.</div>
      </div>
    );
  }

  return (
    <div className="options-rail">
      <div className="options-rail__head">
        <span className="options-rail__title">Key Levels</span>
      </div>
      <ul className="options-rail__list">
        {levels.map((l) => (
          <li key={l.id} className={`options-rail__row is-${l.tone}`}>
            <span className="options-rail__dot" aria-hidden />
            <span className="options-rail__label">{l.label}</span>
            <span className="options-rail__price">
              {l.value.toFixed(l.id === 'spot' ? 2 : 1)}
            </span>
            <span className="options-rail__pct">{fmtPct(l.value, snap.spotPrice)}</span>
          </li>
        ))}
      </ul>
      {snap.hedgeImpulse && (
        <div className="options-rail__attractors">
          <span>
            Below{' '}
            {snap.hedgeImpulse.nearestAttractorBelow != null
              ? snap.hedgeImpulse.nearestAttractorBelow.toFixed(0)
              : '—'}
          </span>
          <span>
            Above{' '}
            {snap.hedgeImpulse.nearestAttractorAbove != null
              ? snap.hedgeImpulse.nearestAttractorAbove.toFixed(0)
              : '—'}
          </span>
        </div>
      )}
    </div>
  );
}

function GexProfile({
  strikes,
  spotPrice,
  zgl,
}: {
  strikes: OptionsStrikeGex[];
  spotPrice: number;
  zgl: number;
}) {
  const sorted = useMemo(
    () => [...(strikes ?? [])].sort((a, b) => b.strike - a.strike),
    [strikes],
  );

  if (sorted.length === 0) {
    return (
      <div className="gex-profile">
        <div className="gex-profile__head">
          <span className="gex-profile__title">GEX by Strike</span>
        </div>
        <div className="gex-profile__empty">Waiting for the first options snapshot.</div>
      </div>
    );
  }

  const maxAbs = Math.max(...sorted.map((s) => Math.abs(s.netGex)), 1);
  const spotTol = spotPrice * 0.004;
  const zglTol = spotPrice * 0.004;

  return (
    <div className="gex-profile">
      <div className="gex-profile__head">
        <div>
          <span className="gex-profile__title">GEX by Strike</span>
          <span className="gex-profile__unit">Net gamma exposure · $</span>
        </div>
        <div className="gex-profile__legend">
          <span className="gex-profile__legend-item">
            <span className="gex-profile__legend-swatch is-neg" />
            Short γ
          </span>
          <span className="gex-profile__legend-item">
            <span className="gex-profile__legend-swatch is-pos" />
            Long γ
          </span>
          <span className="gex-profile__legend-item">
            <span className="gex-profile__legend-line is-spot" />
            Spot
          </span>
          <span className="gex-profile__legend-item">
            <span className="gex-profile__legend-line is-zgl" />
            ZGL
          </span>
        </div>
      </div>

      <div className="gex-profile__axis">
        <span>Strike</span>
        <span className="gex-profile__axis-mid">← short · long →</span>
        <span>Net</span>
      </div>

      <div className="gex-profile__chart">
        {sorted.map((s) => {
          const isSpot = Math.abs(s.strike - spotPrice) < spotTol;
          const isZgl = Math.abs(s.strike - zgl) < zglTol;
          const pct = (Math.abs(s.netGex) / maxAbs) * 100;
          const isPos = s.netGex >= 0;

          return (
            <div
              key={s.strike}
              className={`gex-profile__row${isSpot ? ' is-spot' : ''}${isZgl ? ' is-zgl' : ''}`}
              title={`Strike ${s.strike} · Net ${fmtGexCompact(s.netGex)} · Call OI ${s.callOi.toLocaleString()} · Put OI ${s.putOi.toLocaleString()}`}
            >
              <span className="gex-profile__strike">
                {s.strike.toFixed(0)}
                {isSpot ? ' ◀' : isZgl ? ' ◆' : ''}
              </span>
              <div className="gex-profile__bars">
                <div className="gex-profile__center" />
                <div className="gex-profile__bar-left">
                  {!isPos && (
                    <div
                      className="gex-profile__bar-fill is-neg"
                      style={{ transform: `scaleX(${pct / 100})` }}
                    />
                  )}
                </div>
                <div className="gex-profile__bar-right">
                  {isPos && (
                    <div
                      className="gex-profile__bar-fill is-pos"
                      style={{ transform: `scaleX(${pct / 100})` }}
                    />
                  )}
                </div>
              </div>
              <span className={`gex-profile__net${isPos ? ' is-pos' : ' is-neg'}`}>
                {fmtGexCompact(s.netGex)}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ImpulseCurve({ impulse, spotPrice }: { impulse: OptionsHedgeImpulse; spotPrice: number }) {
  const pts = impulse.curve;
  const W = 320;
  const H = 120;
  const padX = 8;
  const padY = 14;

  const prices = pts.map((p) => p.price);
  const impulses = pts.map((p) => p.impulse);
  const minP = Math.min(...prices);
  const maxP = Math.max(...prices);
  const rangeP = maxP - minP || 1;
  const maxAbs = Math.max(...impulses.map((v) => Math.abs(v)), 1);

  const x = (price: number) => padX + ((price - minP) / rangeP) * (W - padX * 2);
  const y = (imp: number) => H / 2 - (imp / maxAbs) * (H / 2 - padY);

  const path = pts
    .map((p, i) => `${i === 0 ? 'M' : 'L'}${x(p.price).toFixed(2)},${y(p.impulse).toFixed(2)}`)
    .join(' ');
  const spotX = x(Math.max(minP, Math.min(maxP, spotPrice)));
  const midY = H / 2;

  const attractors = [
    impulse.nearestAttractorBelow,
    impulse.nearestAttractorAbove,
  ].filter((v): v is number => v != null && v >= minP && v <= maxP);

  return (
    <div className="options-impulse">
      <div className="options-impulse__head">
        <span className="options-impulse__title">Hedge Impulse</span>
        <span className="options-impulse__meta">+ pin · − accelerate</span>
      </div>
      <svg
        className="options-impulse__svg"
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        role="img"
        aria-label="Hedge impulse curve"
      >
        <line x1={padX} y1={midY} x2={W - padX} y2={midY} className="options-impulse__zero" />
        <line x1={spotX} y1={padY / 2} x2={spotX} y2={H - padY / 2} className="options-impulse__spot" />
        {attractors.map((price) => (
          <line
            key={price}
            x1={x(price)}
            y1={padY / 2}
            x2={x(price)}
            y2={H - padY / 2}
            className="options-impulse__attractor"
          />
        ))}
        <path d={path} className="options-impulse__path" />
      </svg>
      <div className="options-impulse__scale">
        <span>{minP.toFixed(0)}</span>
        <span className="options-impulse__scale-spot">{spotPrice.toFixed(0)}</span>
        <span>{maxP.toFixed(0)}</span>
      </div>
    </div>
  );
}

function PressureBands({ cloud, spotPrice }: { cloud: OptionsPressureCloud; spotPrice: number }) {
  const stability = cloud.stabilityZones ?? [];
  const acceleration = cloud.accelerationZones ?? [];
  const edges = cloud.regimeEdges ?? [];
  const zones = [
    ...stability.map((z) => ({ ...z, kind: 'stability' as const })),
    ...acceleration.map((z) => ({ ...z, kind: 'acceleration' as const })),
  ];

  if (zones.length === 0 && edges.length === 0) return null;

  const prices = [
    spotPrice,
    ...zones.flatMap((z) => [z.lower, z.upper]),
    ...edges.map((e) => e.price),
  ];
  const min = Math.min(...prices);
  const max = Math.max(...prices);
  const range = max - min || 1;
  const pad = range * 0.05;
  const lo = min - pad;
  const hi = max + pad;
  const span = hi - lo || 1;

  const leftPct = (price: number) => ((price - lo) / span) * 100;
  const widthPct = (lower: number, upper: number) => ((upper - lower) / span) * 100;

  return (
    <div className="options-pressure">
      <div className="options-pressure__head">
        <span className="options-pressure__title">Pressure Cloud</span>
        <div className="options-pressure__legend">
          <span>
            <span className="options-pressure__swatch is-stable" />
            Stable
          </span>
          <span>
            <span className="options-pressure__swatch is-accel" />
            Accelerate
          </span>
        </div>
      </div>

      <div className="options-pressure__rail">
        <div className="options-pressure__track" />
        {zones.map((z, i) => (
          <div
            key={`${z.kind}-${i}`}
            className={`options-pressure__band is-${z.kind === 'stability' ? 'stable' : 'accel'}`}
            style={{
              left: `${leftPct(z.lower)}%`,
              width: `${Math.max(1.5, widthPct(z.lower, z.upper))}%`,
              opacity: 0.28 + (Number.isFinite(z.strength) ? z.strength : 0) * 0.55,
            }}
            title={`${z.kind} · ${z.lower.toFixed(0)}–${z.upper.toFixed(0)} · ${z.tradeType} · ${z.hedgeType}`}
          />
        ))}
        {edges.map((e, i) => (
          <div
            key={`edge-${i}`}
            className="options-pressure__edge"
            style={{ left: `${leftPct(e.price)}%` }}
            title={`Regime edge ${e.price.toFixed(0)} · ${e.transitionType}`}
          />
        ))}
        <div
          className="options-pressure__spot"
          style={{ left: `${leftPct(spotPrice)}%` }}
          title={`Spot ${spotPrice.toFixed(2)}`}
        />
      </div>

      <div className="options-pressure__scale">
        <span>{lo.toFixed(0)}</span>
        <span>{spotPrice.toFixed(0)}</span>
        <span>{hi.toFixed(0)}</span>
      </div>

      <ul className="options-pressure__list">
        {zones
          .slice()
          .sort((a, b) => b.strength - a.strength)
          .slice(0, 4)
          .map((z, i) => (
            <li key={i}>
              <span className={`options-pressure__tag is-${z.kind === 'stability' ? 'stable' : 'accel'}`}>
                {z.kind === 'stability' ? 'Stable' : 'Accel'}
              </span>
              <span className="options-pressure__range">
                {z.lower.toFixed(0)}–{z.upper.toFixed(0)}
              </span>
              <span className="options-pressure__dist">{fmtPct(z.center, spotPrice)}</span>
              <span className="options-pressure__str">{(z.strength * 100).toFixed(0)}%</span>
            </li>
          ))}
      </ul>
    </div>
  );
}
