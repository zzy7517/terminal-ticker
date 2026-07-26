import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { AgentMessage } from '../../types';
import { OriginMessageRow } from './OriginSessionPanel';

describe('OriginMessageRow', () => {
  it('keeps partial content visible when the response also has an error', () => {
    const message: AgentMessage = {
      id: 'message-1',
      sessionId: 'origin-1',
      role: 'assistant',
      content: 'Partial answer from Cursor.',
      createdAt: '2026-07-26T12:00:00.000Z',
      metadata: null,
      error: 'Cursor CLI exited with code 1: RetriableError: WritableIterable is closed',
    };

    const html = renderToStaticMarkup(
      <OriginMessageRow message={message} onPreviewImage={() => undefined} />,
    );

    expect(html).toContain('Partial answer from Cursor.');
    expect(html).toContain('WritableIterable is closed');
    expect(html).toContain('origin-message-error');
  });

  it('still renders an error when no partial content was received', () => {
    const message: AgentMessage = {
      id: 'message-2',
      sessionId: 'origin-1',
      role: 'assistant',
      content: '',
      createdAt: '2026-07-26T12:00:00.000Z',
      metadata: null,
      error: 'Cursor CLI exited with code 1',
    };

    const html = renderToStaticMarkup(
      <OriginMessageRow message={message} onPreviewImage={() => undefined} />,
    );

    expect(html).toContain('Cursor CLI exited with code 1');
    expect(html).toContain('origin-message-error');
  });
});
