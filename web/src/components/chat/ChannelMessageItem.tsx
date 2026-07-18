import { useState } from 'react';
import { Bookmark, MessageCircle, Pencil, Pin, Save, Trash2, X } from 'lucide-react';
import type { ChannelMessage } from '../../types';
import { useChatStore } from '../../stores/chatStore';

const QUICK_REACTIONS = ['👍', '👀', '✅'];

export function ChannelMessageItem({
  message,
  onReply,
}: {
  message: ChannelMessage;
  onReply?: (message: ChannelMessage) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(message.content);
  const editMessage = useChatStore((state) => state.editMessage);
  const deleteMessage = useChatStore((state) => state.deleteMessage);
  const toggleReaction = useChatStore((state) => state.toggleReaction);
  const toggleSaved = useChatStore((state) => state.toggleSaved);
  const togglePinned = useChatStore((state) => state.togglePinned);
  const saved = useChatStore((state) => state.saved.some((reference) => (
    reference.messageId === message.id
    && reference.target.kind === 'channel'
    && reference.target.channelId === message.channelId
  )));
  const pinned = useChatStore((state) => state.pinned.some((reference) => (
    reference.messageId === message.id
    && reference.target.kind === 'channel'
    && reference.target.channelId === message.channelId
  )));
  const deleted = message.deletedAtMs !== null;

  async function saveEdit() {
    if (!draft.trim() || draft.trim() === message.content) {
      setEditing(false);
      setDraft(message.content);
      return;
    }
    await editMessage(message.id, draft);
    setEditing(false);
  }

  return (
    <article className={`channel-message${deleted ? ' deleted' : ''}`}>
      <div className="channel-message-meta">
        <strong>{message.authorId === 'owner' ? 'You' : message.authorId}</strong>
        <time>{new Date(message.createdAtMs).toLocaleTimeString()}</time>
        {message.editedAtMs && !deleted ? <small>edited</small> : null}
      </div>
      {editing ? (
        <div className="channel-message-edit">
          <textarea onChange={(event) => setDraft(event.target.value)} rows={3} value={draft} />
          <button className="shell-button sm" onClick={() => void saveEdit()} type="button"><Save size={12} /> Save</button>
          <button className="shell-button sm" onClick={() => { setEditing(false); setDraft(message.content); }} type="button"><X size={12} /> Cancel</button>
        </div>
      ) : (
        <p>{deleted ? 'Message deleted' : message.content}</p>
      )}
      {!deleted && (
        <div className="channel-message-actions">
          {onReply && (
            <button onClick={() => onReply(message)} type="button">
              <MessageCircle size={12} /> {message.replyCount ? `${message.replyCount} replies` : 'Reply'}
            </button>
          )}
          {message.authorType === 'human' && message.authorId === 'owner' && (
            <>
              <button onClick={() => setEditing(true)} type="button"><Pencil size={12} /> Edit</button>
              <button onClick={() => void deleteMessage(message.id)} type="button"><Trash2 size={12} /> Delete</button>
            </>
          )}
          <button
            className={saved ? 'active' : ''}
            onClick={() => void toggleSaved({ kind: 'channel', channelId: message.channelId }, message.id)}
            type="button"
          ><Bookmark size={12} /> {saved ? 'Saved' : 'Save'}</button>
          <button
            className={pinned ? 'active' : ''}
            onClick={() => void togglePinned({ kind: 'channel', channelId: message.channelId }, message.id)}
            type="button"
          ><Pin size={12} /> {pinned ? 'Pinned' : 'Pin'}</button>
        </div>
      )}
      {!deleted && (
        <div className="channel-reactions">
          {QUICK_REACTIONS.map((emoji) => {
            const reaction = message.reactions.find((entry) => entry.emoji === emoji);
            return (
              <button
                className={reaction?.reacted ? 'active' : ''}
                key={emoji}
                onClick={() => void toggleReaction(message, emoji)}
                title={reaction?.reacted ? 'Remove reaction' : 'Add reaction'}
                type="button"
              >
                {emoji}{reaction?.count ? <span>{reaction.count}</span> : null}
              </button>
            );
          })}
        </div>
      )}
    </article>
  );
}
