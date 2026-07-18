import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from 'ink-testing-library';
import { ThemeContext, DEFAULT_THEME } from '../theme.js';
import { ToolCallBlock } from './ToolCallBlock.js';
import { displayWidth } from './word-wrap.js';

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
});

describe('ToolCallBlock', () => {
  it('renders a short collapsed preview for long tool output by default', () => {
    const output = Array.from({ length: 8 }, (_, i) => `line ${i + 1}`).join('\n');
    const view = render(
      withTheme(
        <ToolCallBlock
          name="Bash"
          args={{ command: 'seq 8' }}
          result={{ toolCallId: 'call-1', success: true, output }}
          isExpanded
          reducedMotion
        />,
      ),
    );

    const rendered = frame(view.lastFrame);
    expect(rendered).toContain('line 1');
    expect(rendered).toContain('line 5');
    expect(rendered).not.toContain('line 6');
    expect(rendered).toContain('3 more lines hidden');
    expect(rendered).toContain('Ctrl+E shows all');
  });

  it('renders the larger expanded cap when show-all output is enabled', () => {
    const output = Array.from({ length: 8 }, (_, i) => `line ${i + 1}`).join('\n');
    const view = render(
      withTheme(
        <ToolCallBlock
          name="Bash"
          args={{ command: 'seq 8' }}
          result={{ toolCallId: 'call-1', success: true, output }}
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

  it('includes a truncation summary in screen reader mode', () => {
    const output = Array.from({ length: 12 }, (_, i) => `line ${i + 1}`).join('\n');
    const view = render(
      withTheme(
        <ToolCallBlock
          name="Read"
          args={{ filePath: 'src/a.ts' }}
          result={{ toolCallId: 'call-1', success: true, output }}
          isExpanded
          screenReader
          reducedMotion
        />,
      ),
    );

    const rendered = frame(view.lastFrame);
    expect(rendered).toContain('line 10');
    expect(rendered).not.toContain('line 11');
    expect(rendered).toContain('2 more lines hidden');
  });

  it('uses width-aware truncation for long arguments and errors', () => {
    const longCommand = '🙂'.repeat(60);
    const longError = 'error-' + '🙂'.repeat(80);
    const view = render(
      withTheme(
        <ToolCallBlock
          name="Bash"
          args={{ command: longCommand }}
          result={{ toolCallId: 'call-1', success: false, output: '', error: longError }}
          isExpanded
          reducedMotion
        />,
      ),
    );

    const rendered = frame(view.lastFrame);
    expect(rendered).toContain('…');
    expect(rendered).toContain('│ error-');
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
          result={{
            toolCallId: 'call-1',
            success: true,
            output: diffOutput,
            fileMutation: {
              kind: 'update',
              filePath: 'src/tui/components/Diff.tsx',
              addedLines: 2,
              removedLines: 1,
            },
          }}
          isExpanded={false}
          reducedMotion
        />,
      ),
    );

    const rendered = frame(view.lastFrame);
    expect(rendered).toContain('Update(src/tui/components/Diff.tsx)');
    expect(rendered).toContain('+2 -1');
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
    ].join('\n');
    const view = render(
      withTheme(
        <ToolCallBlock
          name="Edit"
          args={{ filePath: 'src/a.ts' }}
          result={{
            toolCallId: 'call-diff',
            success: true,
            output,
            fileMutation: {
              kind: 'update',
              filePath: 'src/a.ts',
              addedLines: 3,
              removedLines: 3,
            },
          }}
          isExpanded
          reducedMotion
        />,
      ),
    );

    const rendered = frame(view.lastFrame);
    expect(rendered).toContain('-old 2');
    expect(rendered).not.toContain('-old 3');
    expect(rendered).toContain('2 more lines hidden');
    expect(rendered).toContain('Ctrl+E shows all');
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
    ].join('\n');
    const view = render(
      withTheme(
        <ToolCallBlock
          name="Edit"
          args={{ filePath: 'src/a.ts' }}
          result={{ toolCallId: 'call-sr-diff', success: true, output }}
          isExpanded
          screenReader
          reducedMotion
        />,
      ),
    );

    const rendered = frame(view.lastFrame);
    expect(rendered).toContain('-old 2');
    expect(rendered).not.toContain('-old 3');
    expect(rendered).toContain('2 more lines hidden');
  });

  it('renders NotebookEdit as a file update with notebook path and stats', () => {
    const view = render(
      withTheme(
        <ToolCallBlock
          name="NotebookEdit"
          args={{ notebook_path: 'analysis.ipynb', cell_id: 'cell-1', new_source: 'x = 2' }}
          result={{
            toolCallId: 'call-notebook',
            success: true,
            output: '@@ -1,1 +1,1 @@\n- x = 1\n+ x = 2',
            fileMutation: {
              kind: 'update',
              filePath: 'analysis.ipynb',
              addedLines: 1,
              removedLines: 1,
            },
          }}
          isExpanded={false}
          reducedMotion
        />,
      ),
    );

    const rendered = frame(view.lastFrame);
    expect(rendered).toContain('Update(analysis.ipynb)');
    expect(rendered).toContain('+1 -1');
    expect(rendered.split('\n')).toHaveLength(1);
  });

  it('renders a custom Create(filePath) block when a file is created', () => {
    const view = render(
      withTheme(
        <ToolCallBlock
          name="Write"
          args={{ filePath: 'src/new-file.txt' }}
          result={{
            toolCallId: 'call-2',
            success: true,
            output: '@@ -1 +1 @@\n+first line\n+second line',
            fileMutation: {
              kind: 'create',
              filePath: 'src/new-file.txt',
              addedLines: 2,
              removedLines: 0,
            },
          }}
          isExpanded={false}
          reducedMotion
        />,
      ),
    );

    const rendered = frame(view.lastFrame);
    expect(rendered).toContain('Create(src/new-file.txt)');
    expect(rendered).toContain('+2');
    expect(rendered.split('\n')).toHaveLength(1);
  });

  it('renders error messages below the custom file edit block on failure', () => {
    const view = render(
      withTheme(
        <ToolCallBlock
          name="Edit"
          args={{ filePath: 'src/broken.ts' }}
          result={{
            toolCallId: 'call-3',
            success: false,
            output: '',
            error: 'Failed to write file',
          }}
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
          result={{ toolCallId: 'call-4', success: true, output: 'ready' }}
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
          result={{ toolCallId: 'call-5', success: true, output: 'Killed shell shell_1.' }}
          isExpanded={false}
          reducedMotion
        />,
      ),
    );

    expect(frame(outputView.lastFrame)).toContain('Read shell output shell_1');
    expect(frame(killView.lastFrame)).toContain('Kill shell shell_1');
  });

  it('bounds expanded output, arguments, and errors to a narrow width', () => {
    const width = 40;
    const view = render(
      withTheme(
        <ToolCallBlock
          name="Bash"
          args={{ command: `run-${'🙂'.repeat(50)}` }}
          result={{
            toolCallId: 'call-narrow',
            success: false,
            output: `result-${'界'.repeat(80)}`,
            error: `error-${'🙂'.repeat(80)}`,
          }}
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
          result={{
            toolCallId: 'call-markdown',
            success: true,
            output: `| Header | Value |\n|---|---|\n| ${'wide'.repeat(20)} | ${'🙂'.repeat(20)} |`,
          }}
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
