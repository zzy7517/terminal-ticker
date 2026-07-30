export type KeyLevelTone = 'up' | 'down' | 'accent' | 'warning' | 'neutral';

export interface KeyLevelInput {
  callWall: number;
  putWall: number;
  maxGammaStrike: number;
  zeroGammaLevel: number;
  spotPrice: number;
}

export interface KeyLevelRow {
  id: string;
  label: string;
  value: number;
  tone: KeyLevelTone;
}

/** Build non-overlapping key-level rows, high price first. */
export function buildKeyLevels(snap: KeyLevelInput): KeyLevelRow[] {
  return (
    [
      { id: 'call', label: 'Call Wall', value: snap.callWall, tone: 'up' as const },
      { id: 'max', label: 'Max Gamma', value: snap.maxGammaStrike, tone: 'neutral' as const },
      { id: 'zgl', label: 'Zero Gamma', value: snap.zeroGammaLevel, tone: 'warning' as const },
      { id: 'spot', label: 'Spot', value: snap.spotPrice, tone: 'accent' as const },
      { id: 'put', label: 'Put Wall', value: snap.putWall, tone: 'down' as const },
    ] satisfies KeyLevelRow[]
  )
    .filter((l) => Number.isFinite(l.value) && l.value > 0)
    .sort((a, b) => b.value - a.value || a.id.localeCompare(b.id));
}

export function hasPressureContent(cloud: {
  stabilityZones?: unknown[];
  accelerationZones?: unknown[];
  regimeEdges?: unknown[];
} | null | undefined): boolean {
  if (!cloud) return false;
  return (
    (cloud.stabilityZones?.length ?? 0) > 0 ||
    (cloud.accelerationZones?.length ?? 0) > 0 ||
    (cloud.regimeEdges?.length ?? 0) > 0
  );
}
