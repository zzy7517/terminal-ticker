// 提供前端批量 follow-up 队列的纯函数规则。
import type { ImageAttachment } from '../api';
import type { QueuedFollowUp } from '../types';

const MAX_IMAGES_PER_REQUEST = 10;
const MAX_TOTAL_IMAGE_BYTES = 25 * 1024 * 1024;

// 按入队顺序合并 follow-up、当前草稿和图片。
export function mergeFollowUps(
  queued: QueuedFollowUp[],
  draft: string,
  draftImages: ImageAttachment[],
): { prompt: string; images: ImageAttachment[] } {
  return {
    prompt: [...queued.map((item) => item.content.trim()).filter(Boolean), ...(
      draft.trim() ? [draft.trim()] : []
    )].join('\n\n'),
    images: [...queued.flatMap((item) => item.images), ...draftImages],
  };
}

// 校验合并后图片数量和解码总大小是否超限。
export function validateFollowUpImages(images: ImageAttachment[]): string | null {
  if (images.length > MAX_IMAGES_PER_REQUEST) return 'Queued follow-up images exceed the 10-image request limit';
  const totalBytes = images.reduce((sum, image) => sum + Math.floor(image.data.length * 3 / 4), 0);
  return totalBytes > MAX_TOTAL_IMAGE_BYTES
    ? 'Queued follow-up images exceed the 25 MB request limit'
    : null;
}

// 判断当前运行结果是否允许自动消费后续队列。
export function shouldAutoRunFollowUps(
  outcome: 'completed' | 'user-aborted' | 'failed',
  hasQueuedItems: boolean,
): boolean {
  return hasQueuedItems && outcome !== 'failed';
}
