import { describe, expect, it } from 'vitest';
import { originFallbackTarget } from './originNavigation';

describe('Origin navigation', () => {
  it('selects a DM after the last Origin leaves the active list', () => {
    expect(originFallbackTarget([], 'dm-default')).toEqual({ kind: 'direct-message', directMessageId: 'dm-default' });
  });

  it('uses a remaining Origin first and otherwise allows a safe empty target', () => {
    expect(originFallbackTarget(['origin-next'], 'dm-default')).toEqual({ kind: 'origin', sessionId: 'origin-next' });
    expect(originFallbackTarget([], null)).toBeNull();
  });
});
