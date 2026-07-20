/** API 层共享的传输辅助：错误规整与 WebSocket URL 构造。 */

const DEFAULT_DEV_BACKEND_ORIGIN = 'http://127.0.0.1:8765';

export function stateSocketUrl(): string {
  const origin = import.meta.env.DEV
    ? import.meta.env.VITE_BACKEND_ORIGIN || DEFAULT_DEV_BACKEND_ORIGIN
    : window.location.origin;
  const url = new URL('/ws', origin);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.toString();
}

// Builds a user-facing error while preserving structured backend detail when available.
export async function responseError(response: Response, prefix: string): Promise<Error> {
  try {
    const payload = await response.json();
    if (payload && typeof payload.detail === 'string') {
      return new Error(`${prefix}: ${payload.detail}`);
    }
  } catch {
    // Keep the original status fallback when the body is not JSON.
  }
  return new Error(`${prefix}: ${response.status}`);
}
