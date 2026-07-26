import { describe, expect, it } from 'vitest';
import { buildOriginToolView, humanizeToolName, shortenPath } from './originToolDisplay';

const WORKSPACE = '/Users/zhongyuanzhang/.cache/tradex/origin_sessions/workspaces/session-2c5G5e';

describe('buildOriginToolView', () => {
  it('reduces a Cursor shell payload to the command and its stdout', () => {
    const view = buildOriginToolView({
      name: 'shell',
      output: JSON.stringify({
        command: 'pwd',
        workingDirectory: '',
        exitCode: 0,
        signal: '',
        stdout: `${WORKSPACE}\n`,
        stderr: '',
        executionTime: 8258,
        interleavedOutput: `${WORKSPACE}\n`,
        localExecutionTimeMs: 491,
      }),
      workspace: WORKSPACE,
    });

    expect(view.label).toBe('Shell');
    expect(view.summary).toBe('pwd');
    expect(view.output).toBe(WORKSPACE);
    expect(view.output).not.toContain('interleavedOutput');
    expect(view.status).toBe('ok');
  });

  it('surfaces a non-zero exit code as the row detail', () => {
    const view = buildOriginToolView({
      name: 'Bash',
      arguments: { command: 'npm test' },
      output: JSON.stringify({ exitCode: 1, stdout: '', stderr: '2 failing' }),
    });

    expect(view.label).toBe('Shell');
    expect(view.summary).toBe('npm test');
    expect(view.detail).toBe('exit 1');
    expect(view.output).toBe('2 failing');
  });

  it('counts matches from a Cursor grep payload nested under workspaceResults', () => {
    const view = buildOriginToolView({
      name: 'grep',
      output: JSON.stringify({
        pattern: 'observer-design',
        path: WORKSPACE,
        outputMode: 'content',
        workspaceResults: {
          [WORKSPACE]: {
            content: {
              matches: [],
              totalLines: 0,
              totalMatchedLines: 0,
              clientTruncated: false,
              ripgrepTruncated: false,
            },
          },
        },
      }),
      workspace: WORKSPACE,
    });

    expect(view.label).toBe('Grep');
    expect(view.summary).toBe('observer-design');
    expect(view.detail).toBe('0 matches');
    expect(view.output).toBe('');
  });

  it('treats an errorMessage payload as a failed call', () => {
    const view = buildOriginToolView({ name: 'read', output: '{"errorMessage":"File not found"}' });

    expect(view.status).toBe('error');
    expect(view.output).toBe('File not found');
  });

  it('shortens paths against the Session workspace', () => {
    const view = buildOriginToolView({
      name: 'read_file',
      arguments: { path: `${WORKSPACE}/notes/plan.md` },
      output: 'contents',
      workspace: WORKSPACE,
    });

    expect(view.label).toBe('Read');
    expect(view.summary).toBe('notes/plan.md');
    expect(view.input).toContain('"path"');
  });

  it('reports a running call before its result arrives', () => {
    const view = buildOriginToolView({
      name: 'run_command',
      arguments: { command: 'ls -la' },
      running: true,
    });

    expect(view.label).toBe('Shell');
    expect(view.status).toBe('running');
    expect(view.output).toBe('');
  });

  it('pretty-prints payloads it does not recognise', () => {
    const view = buildOriginToolView({ name: 'get_quote', output: '{"symbol":"BTC","last":64000}' });

    expect(view.label).toBe('Get Quote');
    expect(view.icon).toBe('tool');
    expect(view.output).toContain('\n');
    expect(view.summary).toBe('BTC');
  });

  it('never promotes a multi-line payload field into the headline', () => {
    const view = buildOriginToolView({
      name: 'read',
      output: JSON.stringify({ content: 'line one\nline two\nline three' }),
    });

    expect(view.summary).toBe('');
    expect(view.output).toBe('line one\nline two\nline three');
  });

  it('keeps plain text output untouched', () => {
    const view = buildOriginToolView({ name: 'Read', output: 'line one\nline two' });

    expect(view.output).toBe('line one\nline two');
  });

  it('truncates very long output', () => {
    const view = buildOriginToolView({ name: 'Bash', output: 'x'.repeat(5_000) });

    expect(view.truncated).toBe(true);
    expect(view.output).toHaveLength(4_000);
  });
});

describe('humanizeToolName', () => {
  it('title-cases snake and camel case names', () => {
    expect(humanizeToolName('get_exchange_positions')).toBe('Get Exchange Positions');
    expect(humanizeToolName('browserOpenPage')).toBe('Browser Open Page');
  });

  it('leaves qualified names alone', () => {
    expect(humanizeToolName('mcp__linear__list_issues')).toBe('mcp__linear__list_issues');
    expect(humanizeToolName('tradex.tool:call')).toBe('tradex.tool:call');
  });
});

describe('shortenPath', () => {
  it('falls back to the home directory when the path sits outside the workspace', () => {
    expect(shortenPath('/Users/zhongyuanzhang/code/app.ts', WORKSPACE)).toBe('~/code/app.ts');
  });

  it('marks the workspace root itself', () => {
    expect(shortenPath(WORKSPACE, WORKSPACE)).toBe('.');
  });
});
