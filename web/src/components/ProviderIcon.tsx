/**
 * Provider brand icons for Anthropic, Codex, and OpenAI.
 * Renders the appropriate PNG logo at the given size.
 */
const PROVIDER_ICONS: Record<string, string> = {
  anthropic: '/icon-anthropic.png',
  openai: '/icon-openai.png',
  codex: '/icon-codex.png',
};

export function ProviderIcon({ provider, size = 14 }: { provider: string; size?: number }) {
  const src = PROVIDER_ICONS[provider] ?? '/icon-codex.png';
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
