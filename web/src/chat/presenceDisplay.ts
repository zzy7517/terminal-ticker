/**
 * Agent presence → UI 四态（Working / Idle / Error / Paused）的单一映射。
 */
import type { AgentPresence } from '../types';

export type PresenceTone = 'working' | 'idle' | 'error' | 'paused';
export type PresenceLabel = 'Working' | 'Idle' | 'Error' | 'Paused';

export interface PresenceView {
  label: PresenceLabel;
  tone: PresenceTone;
}

/** 将 Coordinator presence（及可选的 session busy）投影为统一 UI 文案与样式 tone。 */
export function agentPresenceView(
  presence: AgentPresence | null | undefined,
  options?: { busy?: boolean },
): PresenceView {
  if (presence?.paused) return { label: 'Paused', tone: 'paused' };
  if (presence?.status === 'error') return { label: 'Error', tone: 'error' };
  if (presence?.running || options?.busy) return { label: 'Working', tone: 'working' };
  return { label: 'Idle', tone: 'idle' };
}
