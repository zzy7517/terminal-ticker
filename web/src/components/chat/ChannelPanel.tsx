/**
 * ChannelPanel — Channel 主聊天面板（对应 Raft Channel 视图）。
 * 含消息列表、composer 与成员面板入口。
 */
import { useEffect, useLayoutEffect, useRef, useState, type UIEvent } from 'react';
import { Hash, Loader2, Users } from 'lucide-react';
import { fetchChannelMembers } from '../../api';
import { useChatStore } from '../../stores/chatStore';
import type { ChannelMessage } from '../../types';
import { ChannelMessageItem } from './ChannelMessageItem';
import { ChannelComposer } from './ChannelComposer';
import { MemberPanel } from './MemberPanel';
import '../../styles/chat/index.css';
import './ChannelPanel.css';

const EMPTY_CHANNEL_MESSAGES: ChannelMessage[] = [];
const FOLLOW_BOTTOM_THRESHOLD_PX = 48;

/** Channel 主面板：时间线 + composer + 成员。 */
export function ChannelPanel() {
  const [draft, setDraft] = useState('');
  const [membersOpen, setMembersOpen] = useState(false);
  const [memberCount, setMemberCount] = useState(0);
  const transcriptRef = useRef<HTMLDivElement>(null);
  const shouldFollowTranscriptRef = useRef(true);
  const pendingOlderScrollHeightRef = useRef<number | null>(null);
  const activeTarget = useChatStore((state) => state.activeTarget);
  const activeChannelId = activeTarget?.kind === 'channel' ? activeTarget.channelId : null;
  const channel = useChatStore((state) => state.channels.find((entry) => entry.id === activeChannelId) ?? null);
  const messages = useChatStore((state) => (
    activeChannelId ? (state.messagesByChannelId[activeChannelId] ?? EMPTY_CHANNEL_MESSAGES) : EMPTY_CHANNEL_MESSAGES
  ));
  const loading = useChatStore((state) => state.loading);
  const sending = useChatStore((state) => state.sending);
  const error = useChatStore((state) => state.error);
  const sendMessage = useChatStore((state) => state.sendMessage);
  const nextBeforeSeq = useChatStore((state) => activeChannelId ? state.nextBeforeSeqByChannelId[activeChannelId] ?? null : null);
  const loadOlderMessages = useChatStore((state) => state.loadOlderMessages);
  const lastMessage = messages[messages.length - 1] ?? null;

  useEffect(() => {
    setMembersOpen(false);
    setMemberCount(0);
    shouldFollowTranscriptRef.current = true;
    pendingOlderScrollHeightRef.current = null;
    if (!activeChannelId) return;
    let cancelled = false;
    async function refreshCount() {
      try {
        const payload = await fetchChannelMembers(activeChannelId!);
        if (!cancelled) setMemberCount(payload.members.length);
      } catch {
        if (!cancelled) setMemberCount(0);
      }
    }
    void refreshCount();
    const timer = setInterval(() => void refreshCount(), 8_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [activeChannelId]);

  // Open / channel switch / initial load: pin to latest message.
  useLayoutEffect(() => {
    const transcript = transcriptRef.current;
    if (!transcript || !activeChannelId || loading) return;
    if (pendingOlderScrollHeightRef.current !== null) return;
    if (!shouldFollowTranscriptRef.current) return;
    transcript.scrollTop = transcript.scrollHeight;
  }, [activeChannelId, loading, messages.length, lastMessage?.id]);

  // After prepending older messages, keep the same viewport relative to prior content.
  useLayoutEffect(() => {
    const transcript = transcriptRef.current;
    const previousHeight = pendingOlderScrollHeightRef.current;
    if (!transcript || previousHeight === null) return;
    transcript.scrollTop = transcript.scrollHeight - previousHeight;
    pendingOlderScrollHeightRef.current = null;
  }, [messages.length]);

  function handleTranscriptScroll(event: UIEvent<HTMLDivElement>) {
    const transcript = event.currentTarget;
    shouldFollowTranscriptRef.current =
      transcript.scrollHeight - transcript.clientHeight - transcript.scrollTop <= FOLLOW_BOTTOM_THRESHOLD_PX;
  }

  async function handleLoadOlder() {
    const transcript = transcriptRef.current;
    if (transcript) pendingOlderScrollHeightRef.current = transcript.scrollHeight;
    shouldFollowTranscriptRef.current = false;
    await loadOlderMessages();
  }

  async function submit() {
    const content = draft.trim();
    if (!content) return;
    setDraft('');
    shouldFollowTranscriptRef.current = true;
    await sendMessage(content);
  }

  return (
    <section className="channel-panel">
      <div className="channel-main agent-card agent-readout agent-session-card">
        <header className="dm-conversation-header">
          <div className="dm-conversation-identity static">
            <span className="dm-conversation-avatar dm-conversation-avatar--icon" aria-hidden="true">
              <Hash size={16} />
            </span>
            <span className="dm-conversation-copy">
              <strong>{channel ? `#${channel.name}` : 'Channel'}</strong>
              <small>{channel?.topic || 'Shared conversation'}</small>
            </span>
          </div>
          <div className="dm-conversation-meta">
            {activeChannelId ? (
              <button
                aria-expanded={membersOpen}
                aria-label={`Members (${memberCount})`}
                className={`channel-members-button${membersOpen ? ' active' : ''}`}
                onClick={() => setMembersOpen((open) => !open)}
                type="button"
              >
                <Users size={14} />
                <span>{memberCount}</span>
              </button>
            ) : null}
          </div>
        </header>

        <div
          className="session-transcript channel-timeline"
          onScroll={handleTranscriptScroll}
          ref={transcriptRef}
        >
          {nextBeforeSeq ? (
            <button className="channel-load-older" disabled={loading} onClick={() => void handleLoadOlder()} type="button">
              {loading ? <Loader2 className="spin" size={13} /> : null} Load earlier messages
            </button>
          ) : null}
          {loading && !messages.length && (
            <div className="empty-state row">
              <Loader2 className="spin" size={15} /> Loading Channel
            </div>
          )}
          {!loading && !messages.length && (
            <div className="dm-beginning">
              <strong>No messages yet</strong>
              <span>Start the conversation.</span>
            </div>
          )}
          {messages.map((message) => (
            <ChannelMessageItem key={message.id} message={message} />
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

        {activeChannelId && membersOpen ? (
          <MemberPanel
            channelId={activeChannelId}
            onClose={() => {
              setMembersOpen(false);
              void fetchChannelMembers(activeChannelId)
                .then((payload) => setMemberCount(payload.members.length))
                .catch(() => undefined);
            }}
          />
        ) : null}
      </div>
    </section>
  );
}
