import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { SessionMessageRow } from './SessionMessageRow';

describe('SessionMessageRow', () => {
  it('renders as an article with leading content ahead of the message body (Channel avatar slot)', () => {
    const html = renderToStaticMarkup(
      <SessionMessageRow
        as="article"
        content="Hello from an agent"
        label="Scout"
        leading={<span className="channel-message-avatar">avatar</span>}
        role="agent"
      />,
    );

    expect(html).toContain('<article');
    expect(html.indexOf('channel-message-avatar')).toBeLessThan(html.indexOf('Hello from an agent'));
    expect(html).toContain('session-message-body');
  });

  it('renders without a body wrapper when there is no leading content (DM rows)', () => {
    const html = renderToStaticMarkup(
      <SessionMessageRow content="Hi" label="You" role="user" />,
    );

    expect(html).not.toContain('session-message-body');
  });

  it('renders footer content such as reactions, and omits it when absent (deleted messages)', () => {
    const withFooter = renderToStaticMarkup(
      <SessionMessageRow
        content="Still here"
        footer={<div className="message-reactions">reactions</div>}
        label="Scout"
        role="agent"
      />,
    );
    expect(withFooter).toContain('message-reactions');

    const deleted = renderToStaticMarkup(
      <SessionMessageRow
        className="channel-message deleted"
        content="Message deleted"
        footer={null}
        label="Scout"
        role="agent"
      />,
    );
    expect(deleted).toContain('Message deleted');
    expect(deleted).toContain('deleted');
    expect(deleted).not.toContain('message-reactions');
  });

  it('renders a streaming cursor instead of markdown when content is empty and streaming is set', () => {
    const html = renderToStaticMarkup(
      <SessionMessageRow
        content={null}
        headAccessory={<span className="spin">spinner</span>}
        label="Scout"
        role="assistant"
        streaming
      />,
    );

    expect(html).toContain('streaming-cursor');
    expect(html).toContain('spin');
    expect(html).not.toContain('markdown-body');
  });

  it('uses the provided label as-is, so callers control assistant naming (agentDisplayName)', () => {
    const html = renderToStaticMarkup(
      <SessionMessageRow content="Reply" label="Trading Desk Bot" role="assistant" />,
    );

    expect(html).toContain('Trading Desk Bot');
  });
});
