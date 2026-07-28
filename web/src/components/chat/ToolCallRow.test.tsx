import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ToolCallRow } from './ToolCallRow';

const CURSOR_SHELL_RESULT = JSON.stringify({
  command: 'pwd',
  workingDirectory: '',
  exitCode: 0,
  signal: '',
  stdout: '/tmp/session-2c5G5e\n',
  stderr: '',
  executionTime: 8258,
  interleavedOutput: '/tmp/session-2c5G5e\n',
  localExecutionTimeMs: 491,
});

describe('ToolCallRow', () => {
  it('collapses a raw result payload into a headline', () => {
    const html = renderToStaticMarkup(
      <ToolCallRow call={{ name: 'shell', output: CURSOR_SHELL_RESULT }} />,
    );

    expect(html).toContain('Shell');
    expect(html).toContain('pwd');
    // The payload keys that used to flood the timeline stay collapsed.
    expect(html).not.toContain('localExecutionTimeMs');
    expect(html).not.toContain('interleavedOutput');
  });

  it('marks a failed call and keeps its message', () => {
    const html = renderToStaticMarkup(
      <ToolCallRow call={{ name: 'read', output: '{"errorMessage":"File not found"}' }} />,
    );

    expect(html).toContain('session-tool-row--error');
  });

  it('leaves a call with no input or output unexpandable', () => {
    const html = renderToStaticMarkup(<ToolCallRow call={{ name: 'shell', output: '' }} />);

    expect(html).toContain('disabled');
    expect(html).not.toContain('session-tool-chevron');
  });
});
