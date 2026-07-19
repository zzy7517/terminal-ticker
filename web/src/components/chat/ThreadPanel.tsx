/**
 * ThreadPanel — Channel thread 侧栏（根消息 + 回复 + composer）。
 */
import { useState } from 'react';
import { Loader2, X } from 'lucide-react';
import { useChatStore } from '../../stores/chatStore';
import { ChannelMessageItem } from './ChannelMessageItem';
import { ChannelComposer } from './ChannelComposer';

/** 打开中的 Channel thread 面板。 */
export function ThreadPanel() {
  const [draft, setDraft] = useState('');
  const rootId = useChatStore((state) => state.openThreadId);
  const thread = useChatStore((state) => rootId ? state.threadsByRootId[rootId] ?? null : null);
  const loading = useChatStore((state) => state.loading);
  const sending = useChatStore((state) => state.sending);
  const closeThread = useChatStore((state) => state.closeThread);
  const sendMessage = useChatStore((state) => state.sendMessage);

  if (!rootId) return null;

  async function submit() {
    const content = draft.trim();
    if (!content) return;
    setDraft('');
    await sendMessage(content, rootId!);
  }

  return (
    <aside className="thread-panel">
      <header><strong>Thread</strong><button onClick={closeThread} title="Close thread" type="button"><X size={15} /></button></header>
      <div className="thread-timeline">
        {loading && !thread ? <div className="empty-state row"><Loader2 className="spin" size={14} /> Loading thread</div> : null}
        {thread ? (
          <>
            <ChannelMessageItem message={thread.root} />
            <div className="thread-reply-divider">{thread.replies.length} replies</div>
            {thread.replies.map((message) => <ChannelMessageItem key={message.id} message={message} />)}
          </>
        ) : null}
      </div>
      <ChannelComposer draft={draft} label="Reply" placeholder="Reply in thread" sending={sending} setDraft={setDraft} submit={submit} />
    </aside>
  );
}
