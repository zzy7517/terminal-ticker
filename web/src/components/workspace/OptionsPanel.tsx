import { useMemo } from 'react';
import { useMarketStore } from '../../stores/marketStore';

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

const REGIME_COLORS: Record<string, string> = {
  long_gamma: '#22c55e',
  short_gamma: '#ef4444',
  neutral: '#eab308',
};

const REGIME_EMOJI: Record<string, string> = {
  long_gamma: '🟢',
  short_gamma: '🔴',
  neutral: '🟡',
};

function formatBillions(value: number): string {
  return `${value >= 0 ? '+' : ''}$${value.toFixed(2)}B`;
}

function formatMoney(value: number | null): string {
  if (value == null) return '—';
  const abs = Math.abs(value);
  if (abs >= 1e9) return `${value >= 0 ? '+' : '-'}$${(abs / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${value >= 0 ? '+' : '-'}$${(abs / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `${value >= 0 ? '+' : '-'}$${(abs / 1e3).toFixed(0)}K`;
  return `$${value.toFixed(0)}`;
}

function pctDiff(level: number, spot: number): string {
  const pct = ((level - spot) / spot) * 100;
  return `${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%`;
}

function GexBar({ strike }: { strike: StrikeGex }) {
  const maxAbs = 1; // Will be normalized by parent
  const callWidth = Math.min(Math.abs(strike.callGex) / maxAbs * 100, 100);
  const putWidth = Math.min(Math.abs(strike.putGex) / maxAbs * 100, 100);

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, height: 16 }}>
      <div style={{ width: 60, textAlign: 'right', fontFamily: 'monospace', opacity: 0.7 }}>
        {strike.strike.toFixed(0)}
      </div>
      <div style={{ flex: 1, display: 'flex', height: 12, position: 'relative' }}>
        <div style={{ position: 'absolute', left: '50%', width: 1, height: '100%', background: '#555' }} />
        {/* Put (left, red) */}
        <div style={{ flex: 1, display: 'flex', justifyContent: 'flex-end' }}>
          <div style={{ width: `${putWidth}%`, background: '#ef4444', borderRadius: 2, minWidth: putWidth > 0 ? 1 : 0 }} />
        </div>
        {/* Call (right, green) */}
        <div style={{ flex: 1 }}>
          <div style={{ width: `${callWidth}%`, background: '#22c55e', borderRadius: 2, minWidth: callWidth > 0 ? 1 : 0 }} />
        </div>
      </div>
    </div>
  );
}

function StrikeChart({ strikes, spotPrice, zgl }: { strikes: StrikeGex[]; spotPrice: number; zgl: number }) {
  if (strikes.length === 0) return <div style={{ opacity: 0.5, padding: 8 }}>No strike data</div>;

  const maxGex = Math.max(...strikes.map(s => Math.max(Math.abs(s.callGex), Math.abs(s.putGex))), 1);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 1, padding: '4px 0' }}>
      {strikes.map((s) => {
        const isSpot = Math.abs(s.strike - spotPrice) < (spotPrice * 0.005);
        const isZgl = Math.abs(s.strike - zgl) < (spotPrice * 0.005);
        const callWidth = Math.abs(s.callGex) / maxGex * 100;
        const putWidth = Math.abs(s.putGex) / maxGex * 100;

        return (
          <div key={s.strike} style={{
            display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, height: 14,
            background: isSpot ? 'rgba(255,255,255,0.05)' : isZgl ? 'rgba(234,179,8,0.1)' : undefined,
          }}>
            <div style={{
              width: 55, textAlign: 'right', fontFamily: 'monospace', opacity: 0.7,
              color: isSpot ? '#60a5fa' : isZgl ? '#eab308' : undefined,
              fontWeight: isSpot || isZgl ? 600 : 400,
            }}>
              {s.strike.toFixed(0)}{isSpot ? ' ◀' : isZgl ? ' ◆' : ''}
            </div>
            <div style={{ flex: 1, display: 'flex', height: 10, position: 'relative' }}>
              <div style={{ position: 'absolute', left: '50%', width: 1, height: '100%', background: '#444' }} />
              <div style={{ flex: 1, display: 'flex', justifyContent: 'flex-end' }}>
                <div style={{ width: `${putWidth}%`, background: '#ef4444aa', borderRadius: 1, minWidth: putWidth > 0.5 ? 1 : 0 }} />
              </div>
              <div style={{ flex: 1 }}>
                <div style={{ width: `${callWidth}%`, background: '#22c55eaa', borderRadius: 1, minWidth: callWidth > 0.5 ? 1 : 0 }} />
              </div>
            </div>
          </div>
        );
      })}
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, opacity: 0.5, paddingTop: 4, marginLeft: 59 }}>
        <span>◀ Put GEX (negative)</span>
        <span>Call GEX (positive) ▶</span>
      </div>
    </div>
  );
}

export function OptionsPanel() {
  const state = useMarketStore((s) => s.state);
  const optionsData = (state as any)?.options?.snapshots as Record<string, OptionsSnapshot> | undefined;

  const symbols = useMemo(() => {
    if (!optionsData) return [];
    return Object.keys(optionsData);
  }, [optionsData]);

  if (!optionsData || symbols.length === 0) {
    return (
      <div style={{ padding: 16, opacity: 0.6 }}>
        <h3 style={{ margin: 0, marginBottom: 8 }}>Options / GEX Analysis</h3>
        <p style={{ margin: 0, fontSize: 13 }}>
          Not enabled. Add <code>[options] enabled = true</code> to your watchlist.toml.
        </p>
      </div>
    );
  }

  return (
    <div style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 16, overflow: 'auto', height: '100%' }}>
      <h3 style={{ margin: 0, fontSize: 14, fontWeight: 600 }}>Options / GEX Analysis</h3>

      {symbols.map((sym) => {
        const snap = optionsData[sym];
        if (!snap) return null;

        return (
          <div key={sym} style={{ border: '1px solid #333', borderRadius: 6, padding: 10 }}>
            {/* Header */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
              <span style={{ fontWeight: 600, fontSize: 14 }}>{snap.symbol}</span>
              <span style={{ fontSize: 12, opacity: 0.6 }}>
                {snap.provider} • {new Date(snap.timestamp).toLocaleTimeString()}
              </span>
            </div>

            {/* Stat tiles */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8, marginBottom: 10 }}>
              <StatTile label="Net GEX" value={formatBillions(snap.netGexBillions)} color={REGIME_COLORS[snap.regime]} />
              <StatTile
                label="Regime"
                value={`${REGIME_EMOJI[snap.regime]} ${snap.regime.replace('_', ' ')}`}
                color={REGIME_COLORS[snap.regime]}
              />
              <StatTile
                label="Zero Gamma"
                value={`${snap.zeroGammaLevel.toFixed(1)} (${pctDiff(snap.zeroGammaLevel, snap.spotPrice)})`}
              />
              <StatTile
                label="Hidden Flow"
                value={formatMoney(snap.charmFlow != null && snap.vannaFlow != null ? snap.charmFlow + snap.vannaFlow : null)}
                sublabel={snap.charmFlow != null ? `C:${formatMoney(snap.charmFlow)} V:${formatMoney(snap.vannaFlow)}` : undefined}
              />
            </div>

            {/* Key Levels */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8, marginBottom: 10, fontSize: 11 }}>
              <LevelPill label="Call Wall" value={snap.callWall} spot={snap.spotPrice} color="#22c55e" />
              <LevelPill label="Put Wall" value={snap.putWall} spot={snap.spotPrice} color="#ef4444" />
              <LevelPill label="Max Gamma" value={snap.maxGammaStrike} spot={snap.spotPrice} color="#a78bfa" />
              <LevelPill label="Spot" value={snap.spotPrice} spot={snap.spotPrice} color="#60a5fa" />
            </div>

            {/* GEX by Strike Chart */}
            {snap.gexByStrike && snap.gexByStrike.length > 0 && (
              <StrikeChart strikes={snap.gexByStrike} spotPrice={snap.spotPrice} zgl={snap.zeroGammaLevel} />
            )}
          </div>
        );
      })}
    </div>
  );
}

function StatTile({ label, value, color, sublabel }: { label: string; value: string; color?: string; sublabel?: string }) {
  return (
    <div style={{ background: '#1a1a2e', borderRadius: 4, padding: '6px 8px' }}>
      <div style={{ fontSize: 10, opacity: 0.5, marginBottom: 2 }}>{label}</div>
      <div style={{ fontSize: 13, fontWeight: 600, color: color ?? '#e2e8f0', fontFamily: 'monospace' }}>{value}</div>
      {sublabel && <div style={{ fontSize: 9, opacity: 0.4, marginTop: 1 }}>{sublabel}</div>}
    </div>
  );
}

function LevelPill({ label, value, spot, color }: { label: string; value: number; spot: number; color: string }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 1 }}>
      <span style={{ fontSize: 9, opacity: 0.5 }}>{label}</span>
      <span style={{ fontSize: 12, fontWeight: 600, color, fontFamily: 'monospace' }}>{value.toFixed(1)}</span>
      <span style={{ fontSize: 9, opacity: 0.4 }}>{pctDiff(value, spot)}</span>
    </div>
  );
}
