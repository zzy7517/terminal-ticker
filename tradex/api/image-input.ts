import type { ImageContent } from "@earendil-works/pi-ai";

export const IMAGE_FILE_EXTENSIONS: Readonly<Record<string, string>> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
};

const MAX_IMAGE_COUNT = 10;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_TOTAL_IMAGE_BYTES = 25 * 1024 * 1024;
const MAX_ENCODED_IMAGE_LENGTH = Math.ceil(MAX_IMAGE_BYTES / 3) * 4;

/** Validates the shared image contract before any Runtime-specific capability check. */
export function validateImageInput(images: ImageContent[]): string | null {
  if (images.length > MAX_IMAGE_COUNT) return "at most 10 images are allowed";
  let totalBytes = 0;
  for (const image of images) {
    if (!IMAGE_FILE_EXTENSIONS[image.mimeType]) return `unsupported image type: ${image.mimeType}`;
    if (!image.data || image.data.length > MAX_ENCODED_IMAGE_LENGTH
      || image.data.length % 4 !== 0 || !hasBase64AlphabetAndPadding(image.data)) {
      return "image data must be valid base64";
    }
    const decoded = Buffer.from(image.data, "base64");
    if (decoded.toString("base64") !== image.data) return "image data must be valid base64";
    if (decoded.byteLength > MAX_IMAGE_BYTES) return "each image must be at most 20 MB";
    totalBytes += decoded.byteLength;
    if (totalBytes > MAX_TOTAL_IMAGE_BYTES) return "images must be at most 25 MB in total";
  }
  return null;
}

function hasBase64AlphabetAndPadding(value: string): boolean {
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  const contentLength = value.length - padding;
  for (let index = 0; index < contentLength; index += 1) {
    const code = value.charCodeAt(index);
    const valid = (code >= 65 && code <= 90)
      || (code >= 97 && code <= 122)
      || (code >= 48 && code <= 57)
      || code === 43
      || code === 47;
    if (!valid) return false;
  }
  for (let index = contentLength; index < value.length; index += 1) {
    if (value.charCodeAt(index) !== 61) return false;
  }
  return true;
}
