import { describe, expect, it } from 'vitest';
import { buildKeyLevels, hasPressureContent } from './optionsKeyLevels';

describe('buildKeyLevels', () => {
  it('sorts high to low and keeps near-spot levels as separate rows', () => {
    const rows = buildKeyLevels({
      callWall: 680,
      maxGammaStrike: 676,
      zeroGammaLevel: 675.8,
      spotPrice: 675.84,
      putWall: 640,
    });
    expect(rows.map((r) => r.id)).toEqual(['call', 'max', 'spot', 'zgl', 'put']);
    expect(rows).toHaveLength(5);
  });

  it('drops non-positive levels', () => {
    const rows = buildKeyLevels({
      callWall: 0,
      maxGammaStrike: 100,
      zeroGammaLevel: 0,
      spotPrice: 99,
      putWall: -1,
    });
    expect(rows.map((r) => r.id)).toEqual(['max', 'spot']);
  });
});

describe('hasPressureContent', () => {
  it('is false for empty clouds', () => {
    expect(hasPressureContent(null)).toBe(false);
    expect(hasPressureContent({ stabilityZones: [], accelerationZones: [], regimeEdges: [] })).toBe(false);
  });

  it('is true when any band or edge exists', () => {
    expect(hasPressureContent({ stabilityZones: [{}], accelerationZones: [], regimeEdges: [] })).toBe(true);
    expect(hasPressureContent({ stabilityZones: [], accelerationZones: [], regimeEdges: [{}] })).toBe(true);
  });
});
