import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from 'ink-testing-library';
import { act } from 'react';
import { ThemeContext, DEFAULT_THEME } from '../theme.js';
import { ToolCallBlock } from './ToolCallBlock.js';
import { displayWidth } from './word-wrap.js';
import type { FileMutationSummary, ToolResult } from '../../types.js';

function successResult(
  toolCallId: string,
  content: string,
  fileMutation?: FileMutationSummary,
): ToolResult {
  return {
    version: 2,
    toolCallId,
    status: 'success',
    content,
    ...(fileMutation ? { artifacts: { fileMutation } } : {}),
  };
}

function failureResult(toolCallId: string, message: string, content = ''): ToolResult {
  return {
    version: 2,
    toolCallId,
    status: 'error',
    content,
    structuredError: { code: 'test_error', message, retryable: false },
  };
}

function stripAnsi(value: string | undefined): string {
  return (value ?? '').replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '');
}

function frame(lastFrame: () => string | undefined): string {
  return stripAnsi(lastFrame());
}

function withTheme(children: React.ReactElement): React.ReactElement {
  return <ThemeContext.Provider value={DEFAULT_THEME}>{children}</ThemeContext.Provider>;
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('ToolCallBlock', () => {
  it('uses a single status marker without tree or disclosure decoration', () => {
    const view = render(
      withTheme(
        <ToolCallBlock
          name="Bash"
          args={{ command: 'npm test' }}
          result={{
            version: 2,
            toolCallId: 'call-1',
            status: 'success',
            content: 'passed',
          }}
          isExpanded={false}
          reducedMotion
        />,
      ),
    );

    const rendered = frame(view.lastFrame);
    expect(rendered.match(/✓/g)).toHaveLength(1);
    expect(rendered).not.toMatch(/[╰├›⌄]/);
  });

  it('updates elapsed time while a tool remains active', () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const view = render(
      withTheme(
        <ToolCallBlock name="Bash" args={{ command: 'npm test' }} isExpanded reducedMotion />,
      ),
    );

    act(() => vi.advanceTimersByTime(1500));
    expect(frame(view.lastFrame)).toContain('1.5s');
  });

  it('renders a short collapsed preview for long tool output by default', () => {
    const output = Array.from({ length: 8 }, (_, i) => `line ${i + 1}`).join('\n');
    const view = render(
      withTheme(
        <ToolCallBlock
          name="Bash"
          args={{ command: 'seq 8' }}
          result={successResult('call-1', output)}
          isExpanded
          reducedMotion
        />,
      ),
    );

    const rendered = frame(view.lastFrame);
    expect(rendered).toContain('line 1');
    expect(rendered).toContain('line 3');
    expect(rendered).toContain('line 6');
    expect(rendered).toContain('line 8');
    expect(rendered).not.toContain('line 4');
    expect(rendered).toContain('2 more lines hidden, 14 B');
    expect(rendered).toContain('Ctrl+E shows all');
  });

  it('renders the larger expanded cap when show-all output is enabled', () => {
    const output = Array.from({ length: 8 }, (_, i) => `line ${i + 1}`).join('\n');
    const view = render(
      withTheme(
        <ToolCallBlock
          name="Bash"
          args={{ command: 'seq 8' }}
          result={successResult('call-1', output)}
          isExpanded
          showAllToolOutput
          reducedMotion
        />,
      ),
    );

    const rendered = frame(view.lastFrame);
    expect(rendered).toContain('line 8');
    expect(rendered).not.toContain('more lines hidden');
  });

  it('keeps tool output flat and complete in screen reader mode', () => {
    const output = Array.from({ length: 12 }, (_, i) => `line ${i + 1}`).join('\n');
    const view = render(
      withTheme(
        <ToolCallBlock
          name="Read"
          args={{ filePath: 'src/a.ts' }}
          result={successResult('call-1', output)}
          isExpanded
          screenReader
          reducedMotion
        />,
      ),
    );

    const rendered = frame(view.lastFrame);
    expect(rendered).toContain('line 10');
    expect(rendered).toContain('line 12');
    expect(rendered).not.toContain('more lines hidden');
  });

  it('uses width-aware truncation for long arguments and errors', () => {
    const longCommand = '🙂'.repeat(60);
    const longError = 'error-' + '🙂'.repeat(80);
    const view = render(
      withTheme(
        <ToolCallBlock
          name="Bash"
          args={{ command: longCommand }}
          result={failureResult('call-1', longError)}
          isExpanded
          reducedMotion
        />,
      ),
    );

    const rendered = frame(view.lastFrame);
    expect(rendered).toContain('…');
    expect(rendered).toContain('· error-');
  });

  it('renders a custom Update(filePath) block with stats for file updates', () => {
    const diffOutput = [
      '@@ -1,3 +1,4 @@',
      ' unchanged',
      '-deleted line',
      '+added line 1',
      '+added line 2',
      ' context',
    ].join('\n');

    const view = render(
      withTheme(
        <ToolCallBlock
          name="Edit"
          args={{ filePath: 'src/tui/components/Diff.tsx' }}
          result={successResult('call-1', diffOutput, {
            kind: 'update',
            filePath: 'src/tui/components/Diff.tsx',
            addedLines: 2,
            removedLines: 1,
          })}
          isExpanded={false}
          reducedMotion
        />,
      ),
    );

    const rendered = frame(view.lastFrame);
    expect(rendered).toContain('Update(src/tui/components/Diff.tsx)');
    expect(rendered).toContain('· +2 -1');
    expect(rendered.split('\n')).toHaveLength(1);
  });

  it('renders a bounded expanded file diff preview', () => {
    const output = [
      '@@ -1,8 +1,8 @@',
      '-old 1',
      '+new 1',
      '-old 2',
      '+new 2',
      '-old 3',
      '+new 3',
      '-old 4',
      '+new 4',
    ].join('\n');
    const view = render(
      withTheme(
        <ToolCallBlock
          name="Edit"
          args={{
            filePath: 'src/a.ts',
            oldString: 'old 1',
            newString: 'new 1',
            replaceAll: false,
          }}
          result={successResult('call-diff', output, {
            kind: 'update',
            filePath: 'src/a.ts',
            addedLines: 3,
            removedLines: 3,
          })}
          isExpanded
          reducedMotion
        />,
      ),
    );

    const rendered = frame(view.lastFrame);
    expect(rendered).toContain('- old 2');
    expect(rendered).toContain('- old 4');
    expect(rendered).not.toContain('filePath:');
    expect(rendered).not.toContain('oldString:');
    expect(rendered).not.toContain('newString:');
    expect(rendered).not.toContain('replaceAll:');
    expect(rendered).not.toContain('rows omitted');
  });

  it('bounds expanded file diffs in screen reader mode', () => {
    const output = [
      '@@ -1,8 +1,8 @@',
      '-old 1',
      '+new 1',
      '-old 2',
      '+new 2',
      '-old 3',
      '+new 3',
      '-old 4',
      '+new 4',
    ].join('\n');
    const view = render(
      withTheme(
        <ToolCallBlock
          name="Edit"
          args={{ filePath: 'src/a.ts' }}
          result={successResult('call-sr-diff', output)}
          isExpanded
          screenReader
          reducedMotion
        />,
      ),
    );

    const rendered = frame(view.lastFrame);
    expect(rendered).toContain('-old 2');
    expect(rendered).toContain('-old 4');
    expect(rendered).not.toContain('rows and');
  });

  it('renders NotebookEdit as a file update with notebook path and stats', () => {
    const view = render(
      withTheme(
        <ToolCallBlock
          name="NotebookEdit"
          args={{ notebook_path: 'analysis.ipynb', cell_id: 'cell-1', new_source: 'x = 2' }}
          result={successResult('call-notebook', '@@ -1,1 +1,1 @@\n- x = 1\n+ x = 2', {
            kind: 'update',
            filePath: 'analysis.ipynb',
            addedLines: 1,
            removedLines: 1,
          })}
          isExpanded={false}
          reducedMotion
        />,
      ),
    );

    const rendered = frame(view.lastFrame);
    expect(rendered).toContain('Update(analysis.ipynb)');
    expect(rendered).toContain('· +1 -1');
    expect(rendered.split('\n')).toHaveLength(1);
  });

  it('renders a custom Create(filePath) block when a file is created', () => {
    const view = render(
      withTheme(
        <ToolCallBlock
          name="Write"
          args={{ filePath: 'src/new-file.txt' }}
          result={successResult('call-2', '@@ -1 +1 @@\n+first line\n+second line', {
            kind: 'create',
            filePath: 'src/new-file.txt',
            addedLines: 2,
            removedLines: 0,
          })}
          isExpanded={false}
          reducedMotion
        />,
      ),
    );

    const rendered = frame(view.lastFrame);
    expect(rendered).toContain('Create(src/new-file.txt)');
    expect(rendered).toContain('· +2');
    expect(rendered.split('\n')).toHaveLength(1);
  });

  it('renders error messages below the custom file edit block on failure', () => {
    const view = render(
      withTheme(
        <ToolCallBlock
          name="Edit"
          args={{ filePath: 'src/broken.ts' }}
          result={failureResult('call-3', 'Failed to write file')}
          isExpanded={false}
          reducedMotion
        />,
      ),
    );

    const rendered = frame(view.lastFrame);
    expect(rendered).toContain('Update(src/broken.ts)');
    expect(rendered).toContain('Failed to write file');
  });

  it('renders friendly labels for background shell tools', () => {
    const outputView = render(
      withTheme(
        <ToolCallBlock
          name="BashOutput"
          args={{ shell_id: 'shell_1' }}
          result={successResult('call-4', 'ready')}
          isExpanded={false}
          reducedMotion
        />,
      ),
    );
    const killView = render(
      withTheme(
        <ToolCallBlock
          name="KillShell"
          args={{ shell_id: 'shell_1' }}
          result={successResult('call-5', 'Killed shell shell_1.')}
          isExpanded={false}
          reducedMotion
        />,
      ),
    );

    expect(frame(outputView.lastFrame)).toContain('Shell output(shell_1)');
    expect(frame(killView.lastFrame)).toContain('Kill shell(shell_1)');
  });

  it('bounds expanded output, arguments, and errors to a narrow width', () => {
    const width = 40;
    const view = render(
      withTheme(
        <ToolCallBlock
          name="Bash"
          args={{ command: `run-${'🙂'.repeat(50)}` }}
          result={failureResult(
            'call-narrow',
            `error-${'🙂'.repeat(80)}`,
            `result-${'界'.repeat(80)}`,
          )}
          isExpanded
          terminalWidth={width}
          reducedMotion
        />,
      ),
    );

    const rendered = frame(view.lastFrame);
    expect(rendered.split('\n')[1]?.trim()).not.toBe('│');
    for (const line of rendered.split('\n')) {
      expect(displayWidth(line), JSON.stringify(line)).toBeLessThanOrEqual(width);
    }
  });

  it('passes the narrow budget to markdown-looking tool output', () => {
    const width = 40;
    const view = render(
      withTheme(
        <ToolCallBlock
          name="WebFetch"
          args={{ url: 'https://example.com' }}
          result={successResult(
            'call-markdown',
            `| Header | Value |\n|---|---|\n| ${'wide'.repeat(20)} | ${'🙂'.repeat(20)} |`,
          )}
          isExpanded
          terminalWidth={width}
          reducedMotion
        />,
      ),
    );

    const rendered = frame(view.lastFrame);
    for (const line of rendered.split('\n')) {
      expect(displayWidth(line), JSON.stringify(line)).toBeLessThanOrEqual(width);
    }
  });
});
