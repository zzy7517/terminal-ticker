import { describe, expect, it } from 'vitest';
import { chronologicalMessages, unreadCountForTarget, channelTarget, directMessageTarget } from './timeline';
import { createChatShellController } from './shellController';
import { projectDirectMessageTimeline } from './directMessageTimeline';

describe('Chat Target Timeline', () => {
  it('reverses newest-first pages into chronological order', () => {
    expect(chronologicalMessages([{ id: 'b' }, { id: 'a' }])).toEqual([{ id: 'a' }, { id: 'b' }]);
  });

  it('reads unread counts by Chat Target', () => {
    const unread = [
      { target: channelTarget('c1'), unreadCount: 3, lastReadSeq: 1 },
      { target: directMessageTarget('d1'), unreadCount: 2, lastReadSeq: 0 },
    ];
    expect(unreadCountForTarget(unread, channelTarget('c1'))).toBe(3);
    expect(unreadCountForTarget(unread, directMessageTarget('d1'))).toBe(2);
    expect(unreadCountForTarget(unread, channelTarget('missing'))).toBe(0);
  });
});

describe('Direct Message Timeline projection', () => {
  it('maps Shared Message Fabric authors onto transcript roles', () => {
    const items = projectDirectMessageTimeline('dm-1', [
      { id: '1', authorType: 'human', content: 'hi', createdAtMs: 1 } as never,
      { id: '2', authorType: 'agent', content: 'yo', createdAtMs: 2 } as never,
      { id: '3', authorType: 'system', content: 'note', createdAtMs: 3 } as never,
    ]);
    expect(items.map((item) => item.role)).toEqual(['user', 'assistant', 'system']);
    expect(items[0]?.directMessageId).toBe('dm-1');
  });
});

describe('Chat Shell Controller', () => {
  it('routes open/send through one interface', async () => {
    const calls: string[] = [];
    let active: ReturnType<typeof channelTarget> | null = null;
    const shell = createChatShellController({
      initChat: () => {
        calls.push('init');
        return () => undefined;
      },
      selectChannel: async (id) => {
        calls.push(`channel:${id}`);
        active = channelTarget(id);
      },
      openDirectMessageEntry: async (agentId) => {
        calls.push(`dm:${agentId}`);
        active = directMessageTarget('dm-1');
      },
      sendChannelMessage: async (content) => {
        calls.push(`send:${content}`);
      },
      getActiveTarget: () => active,
    });
    shell.start();
    await shell.openChannel('btc');
    await shell.openDirectMessage('alpha');
    await shell.send('hello');
    expect(calls).toEqual(['init', 'channel:btc', 'dm:alpha', 'send:hello']);
    expect(shell.activeTarget()).toEqual(directMessageTarget('dm-1'));
  });
});
