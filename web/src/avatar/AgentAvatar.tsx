/**
 * Deterministic Agent identity avatar + click-to-reroll control.
 * Style (beam / pokemon) comes from UI prefs; seed stays on the Agent.
 * Size tokens live in avatar.ts — call-site wrappers must not restate px boxes.
 */
import { useState } from 'react';
import Avatar from 'boring-avatars';
import { useAgentStore } from '../stores/agentStore';
import { useUiStore } from '../stores/uiStore';
import {
  avatarPalette,
  avatarSizePx,
  effectiveAvatarSeed,
  pokemonIdFromSeed,
  pokemonSpriteUrl,
  ORIGIN_CONCEPT_SEED,
  ORIGIN_POKEMON_ID,
  type AvatarSeedSource,
  type AvatarSize,
  type AvatarStyle,
  type PaletteTheme,
} from './avatar';
import './AgentAvatar.css';

export type AgentAvatarProps = {
  agent: AvatarSeedSource;
  /** Named size token. Default `md`. */
  size?: AvatarSize;
  className?: string;
};

export type AvatarStylePreviewProps = {
  agent: AvatarSeedSource;
  /** Forced style for Appearance side-by-side previews (private seam). */
  style: AvatarStyle;
  size?: AvatarSize;
  className?: string;
};

export type AvatarRerollButtonProps = {
  agent: AvatarSeedSource;
  size?: AvatarSize;
  disabled?: boolean;
  className?: string;
  title?: string;
};

export type OriginAvatarProps = {
  /** Origin session id. Omit on a draft to get the Origin concept mark. */
  seed?: string | null;
  size?: AvatarSize;
  className?: string;
};

type AvatarFaceProps = {
  agent: AvatarSeedSource;
  size: AvatarSize;
  theme: PaletteTheme;
  avatarStyle: AvatarStyle;
  className?: string;
  /** Origin override: faceless pixel grid instead of a beam portrait. */
  boringVariant?: 'beam' | 'pixel';
  /** Origin override: pin one species instead of hashing the seed. */
  pokemonId?: number;
};

/** Internal renderer — Chat, Origin and Appearance all adapt into this seam. */
function AvatarFace({
  agent,
  size,
  theme,
  avatarStyle,
  className,
  boringVariant = 'beam',
  pokemonId,
}: AvatarFaceProps) {
  const seed = effectiveAvatarSeed(agent);
  const px = avatarSizePx(size);
  const rootClass = className ? `agent-avatar ${className}` : 'agent-avatar';

  if (avatarStyle === 'pokemon') {
    return (
      <span
        aria-hidden="true"
        className={`${rootClass} agent-avatar--pokemon`}
        style={{ height: px, width: px }}
      >
        <img
          alt=""
          decoding="async"
          draggable={false}
          height={px}
          src={pokemonSpriteUrl(pokemonId ?? pokemonIdFromSeed(seed))}
          width={px}
        />
      </span>
    );
  }

  const colors = avatarPalette(theme, seed);
  return (
    <span
      aria-hidden="true"
      className={rootClass}
      style={{ height: px, width: px }}
    >
      <Avatar
        colors={[...colors]}
        name={seed}
        size={px}
        square
        variant={boringVariant}
      />
    </span>
  );
}

/** Render the active UI-pref style for an Agent. */
export function AgentAvatar({ agent, size = 'md', className }: AgentAvatarProps) {
  const theme = useUiStore((state) => state.theme);
  const avatarStyle = useUiStore((state) => state.avatarStyle);
  return (
    <AvatarFace
      agent={agent}
      avatarStyle={avatarStyle}
      className={className}
      size={size}
      theme={theme}
    />
  );
}

/**
 * Origin face: same pipeline and same UI-pref switch as an Agent, rendered so
 * it reads as identity-free. Pixel grids vary per session; Pikachu does not,
 * because a per-seed species would just look like another Agent.
 */
export function OriginAvatar({ seed, size = 'md', className }: OriginAvatarProps) {
  const theme = useUiStore((state) => state.theme);
  const avatarStyle = useUiStore((state) => state.avatarStyle);
  const classes = className ? `agent-avatar--origin ${className}` : 'agent-avatar--origin';
  return (
    <AvatarFace
      agent={{ id: seed || ORIGIN_CONCEPT_SEED }}
      avatarStyle={avatarStyle}
      boringVariant="pixel"
      className={classes}
      pokemonId={ORIGIN_POKEMON_ID}
      size={size}
      theme={theme}
    />
  );
}

/**
 * Appearance-only preview with a forced style.
 * Keeps the override off the public AgentAvatar interface.
 */
export function AvatarStylePreview({
  agent,
  style,
  size = 'lg',
  className,
}: AvatarStylePreviewProps) {
  const theme = useUiStore((state) => state.theme);
  return (
    <AvatarFace
      agent={agent}
      avatarStyle={style}
      className={className}
      size={size}
      theme={theme}
    />
  );
}

/** Click the avatar to mint a new seed and persist it via the Agent store. */
export function AvatarRerollButton({
  agent,
  size = 'md',
  disabled = false,
  className,
  title = 'Click to randomize avatar',
}: AvatarRerollButtonProps) {
  const rerollAgentAvatar = useAgentStore((state) => state.rerollAgentAvatar);
  const [busy, setBusy] = useState(false);
  const classes = ['agent-avatar-reroll', className].filter(Boolean).join(' ');

  return (
    <button
      aria-label={title}
      className={classes}
      disabled={disabled || busy || !agent.id}
      onClick={() => {
        if (!agent.id) return;
        setBusy(true);
        void rerollAgentAvatar(agent.id).finally(() => setBusy(false));
      }}
      title={title}
      type="button"
    >
      <AgentAvatar agent={agent} size={size} />
    </button>
  );
}
