// 验证批量 follow-up 的合并、自动执行和图片限制规则。
import { describe, expect, it } from 'vitest';
import type { QueuedFollowUp } from '../types';
import { mergeFollowUps, shouldAutoRunFollowUps, validateFollowUpImages } from './followUpQueue';

const image = { data: 'aGVsbG8=', mimeType: 'image/png' };

describe('batch follow-up queue', () => {
  it('merges queued items and the confirmed draft into one ordered request', () => {
    const queued: QueuedFollowUp[] = [
      { id: '1', content: 'First', images: [image], createdAt: '2026-07-12T00:00:00.000Z' },
      { id: '2', content: 'Second', images: [], createdAt: '2026-07-12T00:00:01.000Z' },
    ];

    expect(mergeFollowUps(queued, 'Correction', [image])).toEqual({
      prompt: 'First\n\nSecond\n\nCorrection',
      images: [image, image],
    });
  });

  it('auto-runs after success or explicit abort but pauses after failure', () => {
    expect(shouldAutoRunFollowUps('completed', true)).toBe(true);
    expect(shouldAutoRunFollowUps('user-aborted', true)).toBe(true);
    expect(shouldAutoRunFollowUps('failed', true)).toBe(false);
    expect(shouldAutoRunFollowUps('completed', false)).toBe(false);
  });

  it('rejects batches that exceed count or total decoded size limits', () => {
    expect(validateFollowUpImages(Array.from({ length: 11 }, () => image))).toContain('10-image');
    expect(validateFollowUpImages([{ data: 'a'.repeat(35 * 1024 * 1024), mimeType: 'image/png' }])).toContain('25 MB');
  });
});
