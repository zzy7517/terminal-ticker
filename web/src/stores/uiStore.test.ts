import { describe, expect, it, vi } from 'vitest';

describe('UI store module', () => {
  it('loads in a non-browser environment', async () => {
    vi.resetModules();

    await expect(import('./uiStore')).resolves.toBeDefined();
  });
});
