import type { ImageAttachment } from '../types';

export const MAX_ORIGIN_IMAGES = 10;

export function limitOriginImages(images: ImageAttachment[]): ImageAttachment[] {
  return images.slice(0, MAX_ORIGIN_IMAGES);
}
