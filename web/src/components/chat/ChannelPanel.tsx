import { useState } from 'react';
import { Hash, Loader2 } from 'lucide-react';
import { useChatStore } from '../../stores/chatStore';
import { ChannelMessageItem } from './ChannelMessageItem';
import { ThreadPanel } from './ThreadPanel';
import { ChannelComposer } from './ChannelComposer';
import './ChannelPanel.css';

export function ChannelPanel() {
  const [draft, setDraft] = useState('');
  const activeTarget = useChatStore((state) => state.activeTarget);
  const activeChannelId = activeTarget?.kind === 'channel' ? activeTarget.channelId : null;
  const channel = useChatStore((state) => state.channels.find((entry) => entry.id === activeChannelId) ?? null);
  const messages = useChatStore((state) => activeChannelId ? state.messagesByChannelId[activeChannelId] ?? [] : []);
  const loading = useChatStore((state) => state.loading);
  const sending = useChatStore((state) => state.sending);
  const error = useChatStore((state) => state.error);
  const sendMessage = useChatStore((state) => state.sendMessage);
  const openThread = useChatStore((state) => state.openThread);
  const nextBeforeSeq = useChatStore((state) => activeChannelId ? state.nextBeforeSeqByChannelId[activeChannelId] ?? null : null);
  const loadOlderMessages = useChatStore((state) => state.loadOlderMessages);

  async function submit() {
    const content = draft.trim();
    if (!content) return;
    setDraft('');
    await sendMessage(content);
  }

  return (
    <section className="channel-panel">
      <div className="channel-main">
        <header>
          <Hash size={17} />
          <div><strong>{channel?.name ?? 'Channel'}</strong><small>{channel?.topic || 'Shared conversation'}</small></div>
        </header>
        <div className="channel-timeline">
          {nextBeforeSeq ? (
            <button className="channel-load-older" disabled={loading} onClick={() => void loadOlderMessages()} type="button">
              {loading ? <Loader2 className="spin" size={13} /> : null} Load earlier messages
            </button>
          ) : null}
          {loading && !messages.length && <div className="empty-state row"><Loader2 className="spin" size={15} /> Loading Channel</div>}
          {!loading && !messages.length && <div className="empty-state row">No messages yet.</div>}
          {messages.map((message) => (
            <ChannelMessageItem key={message.id} message={message} onReply={(entry) => void openThread(entry.id)} />
          ))}
        </div>
        {error && <div className="channel-error">{error}</div>}
        <ChannelComposer
          draft={draft}
          label="Send"
          placeholder={channel ? `Message #${channel.name}` : 'Select a Channel'}
          sending={sending}
          setDraft={setDraft}
          submit={submit}
        />
      </div>
      <ThreadPanel />
    </section>
  );
}
