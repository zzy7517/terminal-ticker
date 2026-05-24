/**
 * Client-side image resize utility.
 * Resizes images to fit within max dimensions and base64 size limits
 * before sending to the backend.
 */

const MAX_WIDTH = 2000;
const MAX_HEIGHT = 2000;
const MAX_BASE64_BYTES = 4.5 * 1024 * 1024; // 4.5MB (Anthropic limit is 5MB)
const JPEG_QUALITY_STEPS = [0.85, 0.7, 0.55, 0.4];

export interface ResizedImage {
  data: string;      // base64 (no data: prefix)
  mimeType: string;
}

/**
 * Read a File/Blob into a base64 string (without the data: prefix).
 */
function fileToBase64(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      // Strip data:image/...;base64, prefix
      const base64 = result.split(',')[1] ?? '';
      resolve(base64);
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

/**
 * Load a base64 image into an HTMLImageElement.
 */
function loadImage(base64: string, mimeType: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = `data:${mimeType};base64,${base64}`;
  });
}

/**
 * Resize an image using canvas and return base64.
 */
function canvasResize(
  img: HTMLImageElement,
  width: number,
  height: number,
  mimeType: string,
  quality?: number,
): string {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(img, 0, 0, width, height);
  const dataUrl = canvas.toDataURL(mimeType, quality);
  return dataUrl.split(',')[1] ?? '';
}

/**
 * Process an image file for upload: resize if needed, ensure within size limits.
 * Returns null if the image cannot be processed.
 */
export async function processImageForUpload(file: File): Promise<ResizedImage | null> {
  const mimeType = file.type || 'image/png';
  const supportedTypes = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
  if (!supportedTypes.includes(mimeType)) {
    return null;
  }

  try {
    const base64 = await fileToBase64(file);

    // For GIFs, don't resize (loses animation) — just check size
    if (mimeType === 'image/gif') {
      if (base64.length <= MAX_BASE64_BYTES) {
        return { data: base64, mimeType };
      }
      return null; // GIF too large
    }

    const img = await loadImage(base64, mimeType);
    const origW = img.naturalWidth;
    const origH = img.naturalHeight;

    // Check if already within all limits
    if (origW <= MAX_WIDTH && origH <= MAX_HEIGHT && base64.length <= MAX_BASE64_BYTES) {
      return { data: base64, mimeType };
    }

    // Calculate target dimensions
    let targetW = origW;
    let targetH = origH;
    if (targetW > MAX_WIDTH) {
      targetH = Math.round((targetH * MAX_WIDTH) / targetW);
      targetW = MAX_WIDTH;
    }
    if (targetH > MAX_HEIGHT) {
      targetW = Math.round((targetW * MAX_HEIGHT) / targetH);
      targetH = MAX_HEIGHT;
    }

    // Try PNG first
    let resized = canvasResize(img, targetW, targetH, 'image/png');
    if (resized.length <= MAX_BASE64_BYTES) {
      return { data: resized, mimeType: 'image/png' };
    }

    // Try JPEG with decreasing quality
    for (const quality of JPEG_QUALITY_STEPS) {
      resized = canvasResize(img, targetW, targetH, 'image/jpeg', quality);
      if (resized.length <= MAX_BASE64_BYTES) {
        return { data: resized, mimeType: 'image/jpeg' };
      }
    }

    // Progressively reduce dimensions
    let currentW = targetW;
    let currentH = targetH;
    while (currentW > 1 && currentH > 1) {
      currentW = Math.max(1, Math.floor(currentW * 0.75));
      currentH = Math.max(1, Math.floor(currentH * 0.75));
      for (const quality of JPEG_QUALITY_STEPS) {
        resized = canvasResize(img, currentW, currentH, 'image/jpeg', quality);
        if (resized.length <= MAX_BASE64_BYTES) {
          return { data: resized, mimeType: 'image/jpeg' };
        }
      }
    }

    return null; // Cannot resize small enough
  } catch {
    return null;
  }
}
