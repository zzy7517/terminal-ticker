import { describe, expect, it } from 'vitest';
import {
  AVATAR_SIZES,
  avatarPalette,
  avatarSeedSource,
  avatarSizePx,
  effectiveAvatarSeed,
  hashSeed,
  hueFromSeed,
  isAvatarSizeToken,
  isAvatarStyle,
  pokemonIdFromSeed,
  pokemonSpriteUrl,
  POKEMON_SPRITE_COUNT,
  randomAvatarSeed,
} from './avatar';

describe('avatar seed helpers', () => {
  it('falls back to agent id when avatarSeed is empty', () => {
    expect(effectiveAvatarSeed({ id: 'ict' })).toBe('ict');
    expect(effectiveAvatarSeed({ id: 'ict', avatarSeed: null })).toBe('ict');
    expect(effectiveAvatarSeed({ id: 'ict', avatarSeed: '  ' })).toBe('ict');
  });

  it('prefers a persisted avatarSeed', () => {
    expect(effectiveAvatarSeed({ id: 'ict', avatarSeed: 'abc123' })).toBe('abc123');
  });

  it('mints non-empty random seeds', () => {
    expect(randomAvatarSeed().length).toBeGreaterThan(8);
    expect(randomAvatarSeed()).not.toBe(randomAvatarSeed());
  });

  it('builds id-only seed sources when the agent is missing', () => {
    expect(avatarSeedSource('ict')).toEqual({ id: 'ict' });
    expect(avatarSeedSource('ict', { id: 'ict', avatarSeed: 'x' })).toEqual({ id: 'ict', avatarSeed: 'x' });
  });
});

describe('avatar size tokens', () => {
  it('resolves named tokens to the shared px map', () => {
    expect(avatarSizePx('xs')).toBe(AVATAR_SIZES.xs);
    expect(avatarSizePx('md')).toBe(32);
    expect(avatarSizePx()).toBe(AVATAR_SIZES.md);
  });

  it('validates size tokens', () => {
    expect(isAvatarSizeToken('md')).toBe(true);
    expect(isAvatarSizeToken(32)).toBe(false);
  });
});

describe('avatarPalette', () => {
  it('returns five hex swatches for light and dark', () => {
    expect(avatarPalette('light', 'default')).toHaveLength(5);
    expect(avatarPalette('dark', 'default')).toHaveLength(5);
    for (const swatch of [...avatarPalette('light', 'ict'), ...avatarPalette('dark', 'ict')]) {
      expect(swatch).toMatch(/^#[0-9a-fA-F]{6}$/);
    }
  });

  it('is deterministic for the same seed', () => {
    expect(avatarPalette('dark', 'price-action')).toEqual(avatarPalette('dark', 'price-action'));
    expect(hueFromSeed('ict')).toBe(hueFromSeed('ict'));
    expect(hashSeed('default')).toBe(hashSeed('default'));
  });

  it('derives different hues for different agent ids', () => {
    const hues = ['default', 'ict', 'price-action'].map(hueFromSeed);
    expect(new Set(hues).size).toBe(3);
  });

  it('keeps light and dark ladders distinct for the same seed', () => {
    expect(avatarPalette('light', 'ict')).not.toEqual(avatarPalette('dark', 'ict'));
  });
});

describe('pokemon mapping', () => {
  it('maps seeds to National Dex ids in range', () => {
    const id = pokemonIdFromSeed('ict');
    expect(id).toBeGreaterThanOrEqual(1);
    expect(id).toBeLessThanOrEqual(POKEMON_SPRITE_COUNT);
    expect(pokemonIdFromSeed('ict')).toBe(id);
  });

  it('builds pokeapi official-artwork urls', () => {
    expect(pokemonSpriteUrl(25)).toContain('/other/official-artwork/25.png');
    expect(pokemonSpriteUrl(0)).toContain('/other/official-artwork/1.png');
    expect(pokemonSpriteUrl(99999)).toContain(`/other/official-artwork/${POKEMON_SPRITE_COUNT}.png`);
  });

  it('validates avatar styles', () => {
    expect(isAvatarStyle('beam')).toBe(true);
    expect(isAvatarStyle('pokemon')).toBe(true);
    expect(isAvatarStyle('marble')).toBe(false);
  });
});
