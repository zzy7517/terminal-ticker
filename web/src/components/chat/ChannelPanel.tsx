import { useState } from 'react';
import { Hash, Loader2, Send } from 'lucide-react';
import { useChatStore } from '../../stores/chatStore';
import './ChannelPanel.css';

export function ChannelPanel() {
  const [draft, setDraft] = useState('');
  const activeChannelId = useChatStore((state) => state.activeChannelId);
  const channel = useChatStore((state) => state.channels.find((entry) => entry.id === activeChannelId) ?? null);
  const messages = useChatStore((state) => activeChannelId ? state.messagesByChannelId[activeChannelId] ?? [] : []);
  const loading = useChatStore((state) => state.loading);
  const sending = useChatStore((state) => state.sending);
  const error = useChatStore((state) => state.error);
  const sendMessage = useChatStore((state) => state.sendMessage);

  async function submit() {
    const content = draft.trim();
    if (!content) return;
    setDraft('');
    await sendMessage(content);
  }

  return (
    <section className="channel-panel">
      <header>
        <Hash size={17} />
        <div><strong>{channel?.name ?? 'Channel'}</strong><small>{channel?.topic || 'Shared conversation'}</small></div>
      </header>
      <div className="channel-timeline">
        {loading && !messages.length && <div className="empty-state row"><Loader2 className="spin" size={15} /> Loading Channel</div>}
        {!loading && !messages.length && <div className="empty-state row">No messages yet.</div>}
        {messages.map((message) => (
          <article className="channel-message" key={message.id}>
            <div><strong>{message.authorId === 'owner' ? 'You' : message.authorId}</strong><time>{new Date(message.createdAtMs).toLocaleTimeString()}</time></div>
            <p>{message.content}</p>
          </article>
        ))}
      </div>
      {error && <div className="channel-error">{error}</div>}
      <div className="channel-composer">
        <textarea
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              void submit();
            }
          }}
          placeholder={channel ? `Message #${channel.name}` : 'Select a Channel'}
          rows={2}
          value={draft}
        />
        <button className="shell-button primary" disabled={!draft.trim() || sending} onClick={() => void submit()} type="button">
          {sending ? <Loader2 className="spin" size={14} /> : <Send size={14} />} Send
        </button>
      </div>
    </section>
  );
}
