import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ArrowUp, Box, Loader2, Paperclip, Square, X } from 'lucide-react';
import { fetchAgentSkills } from '../../api';
import {
  matchingSkills,
  type SkillSlashQuery,
} from '../../chat/skillCompletion';
import { useOriginStore, type OriginComposerDraft } from '../../stores/originStore';
import type { AgentSkillSummary, ImageAttachment } from '../../types';
import { processImageForUpload } from '../../utils/imageResize';
import { OriginModelPicker } from './OriginModelPicker';
import { createOriginComposerIntent } from './originComposerIntent';

const EMPTY_COMPOSER: OriginComposerDraft = { message: '', images: [], skillNames: [] };
const composerIntent = createOriginComposerIntent(useOriginStore, processImageForUpload);

/** Edits and submits whichever draft or persisted Origin is currently active. */
export function OriginComposer() {
  const selection = useOriginStore((state) => state.selection);
  const sessionId = selection?.kind === 'session' ? selection.sessionId : null;
  const draft = selection?.kind === 'draft' ? selection.draft : null;
  const composer = useOriginStore((state) => (
    sessionId ? state.composerBySessionId[sessionId] ?? EMPTY_COMPOSER : EMPTY_COMPOSER
  ));
  const running = useOriginStore((state) => (
    sessionId ? state.runningIds.has(sessionId) : false
  ));
  const loading = useOriginStore((state) => state.loading);

  const promptRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const skillMenuRef = useRef<HTMLDivElement>(null);
  const [skillCatalog, setSkillCatalog] = useState<AgentSkillSummary[]>([]);
  const [slashQuery, setSlashQuery] = useState<SkillSlashQuery | null>(null);
  const [activeSkillIndex, setActiveSkillIndex] = useState(0);

  const message = draft?.message ?? composer.message;
  const images = draft?.images ?? composer.images;
  const selectionKey = draft
    ? `draft:${draft.materializationId}`
    : sessionId ? `session:${sessionId}` : 'none';
  const starting = draft?.phase === 'starting';
  const disabled = loading || starting || running;
  const canSend = !disabled && (message.trim().length > 0 || images.length > 0);
  const skillCandidates = useMemo(
    () => slashQuery ? matchingSkills(skillCatalog, slashQuery.query) : [],
    [skillCatalog, slashQuery],
  );
  const skillMenuOpen = Boolean(slashQuery && skillCandidates.length > 0);

  useEffect(() => {
    let disposed = false;
    void fetchAgentSkills()
      .then((skills) => { if (!disposed) setSkillCatalog(skills); })
      .catch((loadError) => console.error('Origin skills fetch failed:', loadError));
    return () => { disposed = true; };
  }, []);

  useEffect(() => {
    setSlashQuery(null);
    setActiveSkillIndex(0);
    if (draft?.phase !== 'editing') return;
    const frame = requestAnimationFrame(() => promptRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [draft?.materializationId, selectionKey]);

  useLayoutEffect(() => {
    const menu = skillMenuRef.current;
    const activeOption = menu?.querySelector<HTMLElement>('[aria-selected="true"]');
    if (!menu || !activeOption) return;
    if (activeOption.offsetTop < menu.scrollTop) menu.scrollTop = activeOption.offsetTop;
    else if (activeOption.offsetTop + activeOption.offsetHeight > menu.scrollTop + menu.clientHeight) {
      menu.scrollTop = activeOption.offsetTop + activeOption.offsetHeight - menu.clientHeight;
    }
  }, [activeSkillIndex, skillCandidates]);

  const changeMessage = useCallback((value: string, caret: number | null) => {
    setSlashQuery(composerIntent.changeMessage(value, caret));
    setActiveSkillIndex(0);
  }, []);

  const chooseSkill = useCallback((skill: AgentSkillSummary) => {
    if (!slashQuery) return;
    const caret = composerIntent.chooseSkill(slashQuery, skill.name);
    if (caret === null) return;
    setSlashQuery(null);
    requestAnimationFrame(() => {
      promptRef.current?.focus();
      promptRef.current?.setSelectionRange(caret, caret);
    });
  }, [slashQuery]);

  const handleImageFiles = useCallback(async (files: FileList | File[]) => {
    await composerIntent.addImages(files);
  }, []);

  const handlePaste = useCallback((event: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const imageFiles = Array.from(event.clipboardData?.items ?? [])
      .filter((item) => item.type.startsWith('image/'))
      .map((item) => item.getAsFile())
      .filter((file): file is File => Boolean(file));
    if (imageFiles.length === 0) return;
    event.preventDefault();
    void handleImageFiles(imageFiles);
  }, [handleImageFiles]);

  const handleDrop = useCallback((event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    if (event.dataTransfer.files.length > 0) void handleImageFiles(event.dataTransfer.files);
  }, [handleImageFiles]);

  if (!selection) return null;

  return (
    <div
      className={`origin-composer${draft ? ' origin-composer--draft' : ''}${skillMenuOpen ? ' has-skill-menu' : ''}`}
      onDragOver={(event) => event.preventDefault()}
      onDrop={handleDrop}
    >
      {skillMenuOpen ? (
        <div className="skill-command-menu origin-skill-menu" id="origin-skill-menu" ref={skillMenuRef} role="listbox">
          {skillCandidates.map((skill, index) => (
            <button
              aria-selected={index === activeSkillIndex}
              className={`skill-command-option${index === activeSkillIndex ? ' active' : ''}`}
              id={`origin-skill-option-${skill.name}`}
              key={skill.name}
              onClick={() => chooseSkill(skill)}
              onMouseDown={(event) => event.preventDefault()}
              onMouseEnter={() => setActiveSkillIndex(index)}
              role="option"
              type="button"
            >
              <Box aria-hidden="true" size={17} strokeWidth={1.8} />
              <span className="skill-command-name">{skill.displayName}</span>
              <span className="skill-command-description">{skill.description}</span>
              {index === activeSkillIndex ? <kbd>↑↓</kbd> : null}
            </button>
          ))}
        </div>
      ) : null}

      {images.length > 0 ? (
        <div className="session-pending-images origin-pending-images">
          {images.map((image, index) => (
            <div className="pending-image-thumb" key={`${image.mimeType}:${index}`}>
              <img alt={`Attachment ${index + 1}`} src={`data:${image.mimeType};base64,${image.data}`} />
              <button
                aria-label={`Remove attachment ${index + 1}`}
                className="pending-image-remove"
                disabled={disabled}
                onClick={() => composerIntent.removeImage(index)}
                title="Remove image"
                type="button"
              >
                <X size={12} />
              </button>
            </div>
          ))}
        </div>
      ) : null}

      <textarea
        aria-activedescendant={skillMenuOpen && skillCandidates[activeSkillIndex]
          ? `origin-skill-option-${skillCandidates[activeSkillIndex].name}`
          : undefined}
        aria-controls={skillMenuOpen ? 'origin-skill-menu' : undefined}
        aria-expanded={skillMenuOpen}
        aria-haspopup="listbox"
        disabled={disabled}
        onBlur={() => setSlashQuery(null)}
        onChange={(event) => changeMessage(event.target.value, event.target.selectionStart)}
        onClick={(event) => changeMessage(event.currentTarget.value, event.currentTarget.selectionStart)}
        onKeyDown={(event) => {
          if (slashQuery) {
            if (event.key === 'ArrowDown' && skillCandidates.length > 0) {
              event.preventDefault();
              setActiveSkillIndex((index) => (index + 1) % skillCandidates.length);
              return;
            }
            if (event.key === 'ArrowUp' && skillCandidates.length > 0) {
              event.preventDefault();
              setActiveSkillIndex((index) => (
                index - 1 + skillCandidates.length
              ) % skillCandidates.length);
              return;
            }
            if ((event.key === 'Enter' || event.key === 'Tab') && skillCandidates[activeSkillIndex]) {
              event.preventDefault();
              chooseSkill(skillCandidates[activeSkillIndex]);
              return;
            }
            if (event.key === 'Escape') {
              event.preventDefault();
              setSlashQuery(null);
              return;
            }
          }
          if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault();
            if (canSend) void useOriginStore.getState().send();
          }
        }}
        onPaste={handlePaste}
        placeholder={running ? 'Origin is running' : images.length > 0 ? 'Add a note, or send the image' : 'Message Origin'}
        ref={promptRef}
        rows={draft ? 5 : 3}
        value={message}
      />

      <div className="origin-composer-toolbar">
        <div className="origin-composer-config">
          {draft ? (
            <OriginModelPicker
              config={draft.config}
              disabled={disabled}
              onChange={(config) => useOriginStore.getState().updateDraft({ config })}
            />
          ) : null}
        </div>
        <div className="origin-composer-commands">
          <button
            aria-label="Attach image"
            className="origin-icon-button"
            disabled={disabled}
            onClick={() => fileInputRef.current?.click()}
            title="Attach image, or paste and drop"
            type="button"
          >
            <Paperclip size={17} />
          </button>
          <button
            aria-label={running ? 'Stop Origin' : 'Send message'}
            className={`origin-icon-button origin-primary-action${running ? ' is-running' : ''}`}
            disabled={running ? !sessionId : !canSend}
            onClick={running && sessionId
              ? () => void useOriginStore.getState().stop(sessionId)
              : () => void useOriginStore.getState().send()}
            title={running ? 'Stop Origin' : 'Send message'}
            type="button"
          >
            {starting ? <Loader2 className="spin" size={17} /> : running ? <Square size={15} /> : <ArrowUp size={18} />}
          </button>
        </div>
      </div>

      <input
        accept="image/png,image/jpeg,image/webp,image/gif"
        aria-hidden="true"
        className="origin-file-input"
        multiple
        onChange={(event) => {
          if (event.target.files) void handleImageFiles(event.target.files);
          event.target.value = '';
        }}
        ref={fileInputRef}
        tabIndex={-1}
        type="file"
      />
    </div>
  );
}
