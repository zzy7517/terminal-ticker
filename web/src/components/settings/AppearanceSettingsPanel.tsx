/**
 * Appearance settings: global Agent avatar style (beam / pokemon).
 */
import { AVATAR_STYLES, AvatarStylePreview, type AvatarStyle } from '../../avatar';
import { useAgentStore } from '../../stores/agentStore';
import { useUiStore } from '../../stores/uiStore';
import './AppearanceSettingsPanel.css';

const STYLE_COPY: Record<AvatarStyle, { title: string; body: string }> = {
  beam: {
    title: 'Beam',
    body: 'Generated chrome faces via boring-avatars. No third-party artwork.',
  },
  pokemon: {
    title: 'Pokemon artwork',
    body: 'Loads official artwork from PokeAPI/sprites over CDN. Hobby-only; see README copyright notes.',
  },
};

export function AppearanceSettingsPanel() {
  const avatarStyle = useUiStore((state) => state.avatarStyle);
  const setAvatarStyle = useUiStore((state) => state.setAvatarStyle);
  const agents = useAgentStore((state) => state.agents);
  const previewAgents = agents.slice(0, 4);

  return (
    <section className="appearance-settings">
      <header className="settings-stage-head">
        <div>
          <div className="eyebrow">Identity</div>
          <h2>Appearance</h2>
          <p>Choose how Agent avatars render across Chat, Channel, and Settings.</p>
        </div>
      </header>

      <div className="appearance-style-grid">
        {AVATAR_STYLES.map((style) => {
          const copy = STYLE_COPY[style];
          const active = avatarStyle === style;
          return (
            <button
              className={`appearance-style-card${active ? ' active' : ''}`}
              key={style}
              onClick={() => setAvatarStyle(style)}
              type="button"
            >
              <span className="appearance-style-preview" aria-hidden="true">
                {(previewAgents.length ? previewAgents : [{ id: 'default', avatarSeed: null }]).map((agent) => (
                  <AvatarStylePreview agent={agent} key={`${style}-${agent.id}`} size="lg" style={style} />
                ))}
              </span>
              <strong>{copy.title}</strong>
              <small>{copy.body}</small>
            </button>
          );
        })}
      </div>

      {avatarStyle === 'pokemon' ? (
        <aside className="appearance-copyright">
          <strong>Copyright notice</strong>
          <p>
            Pokemon sprites are © Nintendo / Creatures Inc. / GAME FREAK Inc.
            Tradex does not redistribute sprite files; it loads them at runtime from
            {' '}<a href="https://github.com/PokeAPI/sprites" rel="noreferrer" target="_blank">PokeAPI/sprites</a>.
            This option is for personal hobby use only. Do not treat it as a license for commercial redistribution.
          </p>
        </aside>
      ) : null}
    </section>
  );
}
