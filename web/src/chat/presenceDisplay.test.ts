import { describe, expect, it } from 'vitest';
import { agentPresenceView } from './presenceDisplay';
import type { AgentPresence } from '../types';

function presence(partial: Partial<AgentPresence>): AgentPresence {
  return {
    agentId: 'alpha',
    status: 'idle',
    paused: false,
    running: false,
    ...partial,
  };
}

describe('agentPresenceView', () => {
  it('maps paused / error / working / idle in priority order', () => {
    expect(agentPresenceView(presence({ paused: true, running: true, status: 'error' }))).toEqual({
      label: 'Paused',
      tone: 'paused',
    });
    expect(agentPresenceView(presence({ status: 'error', running: true }))).toEqual({
      label: 'Error',
      tone: 'error',
    });
    expect(agentPresenceView(presence({ running: true }))).toEqual({
      label: 'Working',
      tone: 'working',
    });
    expect(agentPresenceView(presence({ status: 'idle' }))).toEqual({
      label: 'Idle',
      tone: 'idle',
    });
  });

  it('treats session busy as Working even when presence.running is false', () => {
    expect(agentPresenceView(presence({ running: false }), { busy: true })).toEqual({
      label: 'Working',
      tone: 'working',
    });
  });
});
