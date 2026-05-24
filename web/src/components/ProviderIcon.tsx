/**
 * Provider brand icons for Anthropic and Codex.
 * Renders the appropriate PNG logo at the given size.
 */
export function ProviderIcon({ provider, size = 14 }: { provider: string; size?: number }) {
  const src = provider === 'anthropic' ? '/icon-anthropic.png' : '/icon-codex.png';
  return (
    <img
      src={src}
      alt={provider}
      width={size}
      height={size}
      className="provider-icon"
    />
  );
}
