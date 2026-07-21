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

type AvatarFaceProps = {
  agent: AvatarSeedSource;
  size: AvatarSize;
  theme: PaletteTheme;
  avatarStyle: AvatarStyle;
  className?: string;
};

/** Internal renderer — Chat and Appearance both adapt into this seam. */
function AvatarFace({ agent, size, theme, avatarStyle, className }: AvatarFaceProps) {
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
          src={pokemonSpriteUrl(pokemonIdFromSeed(seed))}
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
        variant="beam"
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
