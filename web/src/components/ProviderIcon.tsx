/**
 * Provider brand marks.
 * - Colored logos render as-is.
 * - Monochrome glyphs (OpenAI) are masked with currentColor so they stay
 *   legible on both themes.
 * - Unknown providers fall back to a neutral letter chip instead of a
 *   wrong brand logo.
 */
const COLOR_ICONS: Record<string, string> = {
  anthropic: '/icon-anthropic.png',
  codex: '/icon-codex.png',
};

const GLYPH_ICONS: Record<string, string> = {
  openai: '/icon-openai.png',
};

export function ProviderIcon({ provider, size = 14 }: { provider: string; size?: number }) {
  const colorSrc = COLOR_ICONS[provider];
  if (colorSrc) {
    return (
      <img
        src={colorSrc}
        alt={provider}
        width={size}
        height={size}
        className="provider-icon"
      />
    );
  }

  const glyphSrc = GLYPH_ICONS[provider];
  if (glyphSrc) {
    return (
      <span
        aria-label={provider}
        className="provider-icon provider-icon--glyph"
        role="img"
        style={{
          height: size,
          width: size,
          WebkitMaskImage: `url(${glyphSrc})`,
          maskImage: `url(${glyphSrc})`,
        }}
      />
    );
  }

  return (
    <span
      aria-label={provider}
      className="provider-icon provider-icon--letter"
      role="img"
      style={{ height: size, width: size, fontSize: Math.max(8, Math.round(size * 0.6)) }}
    >
      {(provider.trim()[0] ?? '?').toUpperCase()}
    </span>
  );
}
