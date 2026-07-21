/**
 * Pure Agent avatar helpers: seed policy, palette, Pokemon mapping, size tokens.
 * Kept free of React/store so unit tests stay Node-clean.
 */

export type AvatarSeedSource = {
  id: string;
  avatarSeed?: string | null;
};

/** Prefer a loaded Agent; otherwise fall back to an id-only seed source. */
export function avatarSeedSource(
  id: string,
  agent?: AvatarSeedSource | null,
): AvatarSeedSource {
  return agent ?? { id };
}

export type ChromePalette = readonly [string, string, string, string, string];

/** Light/dark ladder for seed-derived avatar swatches (not browser chrome). */
export type PaletteTheme = 'light' | 'dark';

/** Global avatar renderer. Stored in UI prefs, not on Agent definitions. */
export type AvatarStyle = 'beam' | 'pokemon';

export const AVATAR_STYLES: readonly AvatarStyle[] = ['beam', 'pokemon'];

/**
 * Named presentation sizes owned by the avatar module.
 * Call sites pass a token; wrappers must not restate px height/width.
 */
export const AVATAR_SIZES = {
  xs: 24,
  sm: 28,
  md: 32,
  lg: 36,
  xl: 40,
} as const;

export type AvatarSizeToken = keyof typeof AVATAR_SIZES;
export type AvatarSize = AvatarSizeToken;

export function isAvatarSizeToken(value: unknown): value is AvatarSizeToken {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(AVATAR_SIZES, value);
}

/** Resolve a size token to an integer CSS pixel length. */
export function avatarSizePx(size: AvatarSize = 'md'): number {
  return AVATAR_SIZES[size];
}

/** Gen 1 National Dex coverage for PokeAPI official artwork. */
export const POKEMON_SPRITE_COUNT = 151;

/** Official artwork renders (high-res); downscales cleanly at chip size. */
const POKEMON_SPRITE_BASE =
  'https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/other/official-artwork';

/** Prefer persisted `avatarSeed`, otherwise fall back to the stable Agent id. */
export function effectiveAvatarSeed(agent: AvatarSeedSource): string {
  const seed = agent.avatarSeed?.trim();
  return seed || agent.id;
}

/** Mint a fresh random seed (for click-to-reroll). */
export function randomAvatarSeed(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID().replace(/-/g, '');
  }
  return `avatar-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** FNV-1a → stable unsigned 32-bit hash. */
export function hashSeed(seed: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < seed.length; i += 1) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** Hue in [0, 360) derived from seed. */
export function hueFromSeed(seed: string): number {
  return hashSeed(seed) % 360;
}

/** Map a seed to a National Dex id in 1..POKEMON_SPRITE_COUNT. */
export function pokemonIdFromSeed(seed: string): number {
  return (hashSeed(seed) % POKEMON_SPRITE_COUNT) + 1;
}

/** PokeAPI-hosted official artwork URL (remote CDN; assets are not vendored). */
export function pokemonSpriteUrl(pokemonId: number): string {
  const id = Math.max(1, Math.min(POKEMON_SPRITE_COUNT, Math.floor(pokemonId)));
  return `${POKEMON_SPRITE_BASE}/${id}.png`;
}

export function isAvatarStyle(value: unknown): value is AvatarStyle {
  return value === 'beam' || value === 'pokemon';
}

function hslToHex(h: number, s: number, l: number): string {
  const sat = Math.max(0, Math.min(100, s)) / 100;
  const light = Math.max(0, Math.min(100, l)) / 100;
  const chroma = (1 - Math.abs(2 * light - 1)) * sat;
  const huePrime = ((h % 360) + 360) % 360 / 60;
  const x = chroma * (1 - Math.abs((huePrime % 2) - 1));
  let r = 0;
  let g = 0;
  let b = 0;

  if (huePrime < 1) [r, g, b] = [chroma, x, 0];
  else if (huePrime < 2) [r, g, b] = [x, chroma, 0];
  else if (huePrime < 3) [r, g, b] = [0, chroma, x];
  else if (huePrime < 4) [r, g, b] = [0, x, chroma];
  else if (huePrime < 5) [r, g, b] = [x, 0, chroma];
  else [r, g, b] = [chroma, 0, x];

  const m = light - chroma / 2;
  const toHex = (channel: number) => Math.round((channel + m) * 255)
    .toString(16)
    .padStart(2, '0');

  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

/** Build a five-stop palette around the seed hue. */
export function avatarPalette(theme: PaletteTheme, seed: string): ChromePalette {
  const hue = hueFromSeed(seed);

  if (theme === 'light') {
    return [
      hslToHex(hue, 30, 20),
      hslToHex(hue, 34, 36),
      hslToHex(hue, 28, 52),
      hslToHex(hue, 20, 70),
      hslToHex(hue, 12, 90),
    ];
  }

  return [
    hslToHex(hue, 24, 88),
    hslToHex(hue, 22, 70),
    hslToHex(hue, 20, 50),
    hslToHex(hue, 18, 32),
    hslToHex(hue, 14, 14),
  ];
}
