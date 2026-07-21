import { describe, expect, it, vi } from 'vitest';
import { chronologicalMessages, unreadCountForTarget, channelTarget, directMessageTarget } from './timeline';
import { createChatShellController } from './shellController';
import { projectDirectMessageTimeline } from './directMessageTimeline';
import { markActiveTargetReadAfterRecovery } from '../stores/chatStore';

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

describe('markActiveTargetReadAfterRecovery', () => {
  it('marks the open Channel after SSE recovery', async () => {
    const markTargetRead = vi.fn(async () => undefined);
    await markActiveTargetReadAfterRecovery({
      activeTarget: channelTarget('c1'),
      recoveredChannelId: 'c1',
      channelTimeline: [
        { id: 'm1', channelSeq: 1 } as never,
        { id: 'm2', channelSeq: 2 } as never,
      ],
      recoveredDirectMessageIds: [],
      markTargetRead,
    });
    expect(markTargetRead).toHaveBeenCalledWith(channelTarget('c1'), 2, 'm2');
  });

  it('does not mark a Channel that is not open', async () => {
    const markTargetRead = vi.fn(async () => undefined);
    await markActiveTargetReadAfterRecovery({
      activeTarget: null,
      recoveredChannelId: 'c1',
      channelTimeline: [{ id: 'm1', channelSeq: 1 } as never],
      recoveredDirectMessageIds: [],
      markTargetRead,
    });
    expect(markTargetRead).not.toHaveBeenCalled();
  });

  it('does not apply a recovered Channel timeline to a different open Channel', async () => {
    const markTargetRead = vi.fn(async () => undefined);
    await markActiveTargetReadAfterRecovery({
      activeTarget: channelTarget('c2'),
      recoveredChannelId: 'c1',
      channelTimeline: [
        { id: 'm1', channelSeq: 9 } as never,
      ],
      recoveredDirectMessageIds: [],
      markTargetRead,
    });
    expect(markTargetRead).not.toHaveBeenCalled();
  });
});
