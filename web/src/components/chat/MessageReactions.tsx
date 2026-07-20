/**
 * MessageReactions — Raft-style hover react control for Channel / DM messages.
 *
 * 默认只显示已有 reaction chips；悬停消息出现选中框与笑脸按钮，点击后弹出快捷表情面板。
 */
import { useEffect, useId, useRef, useState } from 'react';
import { Smile } from 'lucide-react';
import { QUICK_REACTIONS, type ReactionSummary } from '../../chat/reactions';
import './MessageReactions.css';

/** 已有 chips + 悬停触发的表情选择器。 */
export function MessageReactions({
  reactions,
  onToggle,
}: {
  reactions: ReactionSummary[];
  onToggle: (emoji: string) => void;
}) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const pickerId = useId();
  const active = reactions.filter((entry) => entry.count > 0);

  useEffect(() => {
    if (!pickerOpen) return;
    function onPointerDown(event: PointerEvent) {
      if (!rootRef.current?.contains(event.target as Node)) {
        setPickerOpen(false);
      }
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') setPickerOpen(false);
    }
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [pickerOpen]);

  return (
    <div className={`message-reactions${pickerOpen ? ' open' : ''}`} ref={rootRef}>
      <div className="message-react-toolbar">
        <button
          aria-controls={pickerId}
          aria-expanded={pickerOpen}
          aria-haspopup="true"
          className={pickerOpen ? 'active' : ''}
          onClick={() => setPickerOpen((value) => !value)}
          title="Add reaction"
          type="button"
        >
          <Smile size={14} />
        </button>
        {pickerOpen ? (
          <div className="message-react-picker" id={pickerId} role="listbox" aria-label="Choose reaction">
            {QUICK_REACTIONS.map((emoji) => {
              const reaction = reactions.find((entry) => entry.emoji === emoji);
              const selected = Boolean(reaction?.reacted);
              return (
                <button
                  aria-selected={selected}
                  className={selected ? 'active' : ''}
                  key={emoji}
                  onClick={() => {
                    onToggle(emoji);
                    setPickerOpen(false);
                  }}
                  role="option"
                  title={selected ? `Remove ${emoji}` : `React ${emoji}`}
                  type="button"
                >
                  {emoji}
                </button>
              );
            })}
          </div>
        ) : null}
      </div>
      {active.length > 0 ? (
        <div className="message-react-chips" role="group" aria-label="Message reactions">
          {active.map((reaction) => (
            <button
              className={reaction.reacted ? 'active' : ''}
              key={reaction.emoji}
              onClick={() => onToggle(reaction.emoji)}
              title={reaction.reacted ? `Remove ${reaction.emoji}` : `React ${reaction.emoji}`}
              type="button"
            >
              {reaction.emoji}
              <span>{reaction.count}</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
