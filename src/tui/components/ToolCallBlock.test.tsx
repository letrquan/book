import chalk from 'chalk';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from 'ink-testing-library';
import { Box } from 'ink';
import { act } from 'react';
import { ThemeContext, DEFAULT_THEME } from '../theme.js';
import { ToolCallBlock, ToolExpandTargetContext } from './ToolCallBlock.js';
import { ToolRowInteractionContext } from './tool-row-interactions.js';
import { displayWidth } from './word-wrap.js';
import type { FileMutationSummary, ToolResult } from '../../types/tools.js';
import { enrichToolResultPresentation, toolFailure, toolSuccess } from '../../tools/result.js';
import { workloadRows } from '../../test/tool-expand-workload.js';
import { MemoryRootContext, memoryRootDisplay } from '../memory-root.js';
import { toolRowHidesContent } from '../tool-expansion.js';
import { shouldDefaultExpandTool } from '../tool-presentation.js';

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

/** A compact row names the Ctrl+E key only inside a provider whose target is that row. */
function asTarget(toolId: string, block: React.ReactElement): React.ReactElement {
  return (
    <ToolExpandTargetContext.Provider value={toolId}>{block}</ToolExpandTargetContext.Provider>
  );
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

  it('updates elapsed time once per second while a tool remains active', () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const view = render(
      withTheme(<ToolCallBlock name="Bash" args={{ command: 'npm test' }} isExpanded />),
    );

    void act(() => vi.advanceTimersByTime(2500));
    expect(frame(view.lastFrame)).toMatch(/Bash\s+npm test\s+2s$/m);
  });

  it('does not tick elapsed time under reduced motion', () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const view = render(
      withTheme(
        <ToolCallBlock name="Bash" args={{ command: 'npm test' }} isExpanded reducedMotion />,
      ),
    );

    void act(() => vi.advanceTimersByTime(2500));
    expect(frame(view.lastFrame)).not.toMatch(/· \d+s/);
  });

  it('renders a short collapsed preview for long tool output by default', () => {
    const output = Array.from({ length: 8 }, (_, i) => `line ${i + 1}`).join('\n');
    const view = render(
      withTheme(
        asTarget(
          'call-1',
          <ToolCallBlock
            toolId="call-1"
            name="Bash"
            args={{ command: 'seq 8' }}
            result={successResult('call-1', output)}
            isExpanded
            reducedMotion
          />,
        ),
      ),
    );

    const rendered = frame(view.lastFrame);
    expect(rendered).toContain('line 1');
    expect(rendered).toContain('line 3');
    expect(rendered).toContain('line 6');
    expect(rendered).toContain('line 8');
    expect(rendered).not.toContain('line 4');
    expect(rendered).toContain('… +2 lines (Ctrl+E)');
    expect(rendered).not.toContain('more lines hidden');
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
    expect(rendered).not.toContain('… +');
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
    expect(rendered).not.toContain('… +');
  });

  it('omits raw parameters from visual and screen-reader transcripts', () => {
    const args = {
      command: 'npm test',
      workdir: 'PRIVATE_WORKDIR_MARKER',
      run_in_background: false,
      title: 'PRIVATE_TITLE_MARKER',
    };
    const view = render(
      withTheme(
        <ToolCallBlock
          name="Bash"
          args={args}
          result={successResult('call-private-args', 'VISIBLE_OUTPUT_MARKER')}
          isExpanded
          reducedMotion
        />,
      ),
    );

    let rendered = frame(view.lastFrame);
    expect(rendered).toMatch(/Bash\s+npm test/);
    expect(rendered).toContain('VISIBLE_OUTPUT_MARKER');
    expect(rendered).not.toContain('command:');
    expect(rendered).not.toContain('PRIVATE_WORKDIR_MARKER');
    expect(rendered).not.toContain('PRIVATE_TITLE_MARKER');

    view.rerender(
      withTheme(
        <ToolCallBlock
          name="Bash"
          args={args}
          result={successResult('call-private-args', 'VISIBLE_OUTPUT_MARKER')}
          isExpanded
          screenReader
          reducedMotion
        />,
      ),
    );
    rendered = frame(view.lastFrame);
    expect(rendered).toContain('VISIBLE_OUTPUT_MARKER');
    expect(rendered).not.toContain('command:');
    expect(rendered).not.toContain('PRIVATE_WORKDIR_MARKER');
    expect(rendered).not.toContain('PRIVATE_TITLE_MARKER');
  });

  it('uses width-aware truncation for long summaries and errors', () => {
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
    expect(rendered).toContain('error-');
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
    expect(rendered).toMatch(/Edit\s+src\/tui\/components\/Diff\.tsx\s+\+2 -1$/m);
    expect(rendered.split('\n')).toHaveLength(1);
  });

  it('renders the complete file diff when the mutation row is expanded and show-all is on', () => {
    const changedRows = Array.from({ length: 100 }, (_, index) => `+new ${index + 1}`);
    const output = ['@@ -1 +1,100 @@', '-old', ...changedRows].join('\n');
    const view = render(
      withTheme(
        <ToolCallBlock
          name="Edit"
          args={{
            filePath: 'src/a.ts',
            oldString: 'old',
            newString: changedRows.join('\n'),
            replaceAll: false,
          }}
          result={successResult('call-diff', output, {
            kind: 'update',
            filePath: 'src/a.ts',
            addedLines: 100,
            removedLines: 1,
          })}
          isExpanded
          showAllToolOutput
          reducedMotion
        />,
      ),
    );

    const rendered = frame(view.lastFrame);
    expect(rendered).toContain('- old');
    expect(rendered).toContain('+ new 50');
    expect(rendered).toContain('+ new 100');
    expect(rendered).not.toContain('lines omitted');
    expect(rendered).not.toContain('lines hidden');
    expect(rendered).not.toContain('filePath:');
    expect(rendered).not.toContain('oldString:');
    expect(rendered).not.toContain('newString:');
    expect(rendered).not.toContain('replaceAll:');
    expect(rendered).not.toContain('lines omitted');
  });

  describe('capped diffs', () => {
    const newFileDiff = [
      '@@ -0,0 +1,150 @@',
      ...Array.from({ length: 150 }, (_, index) => `+line ${index + 1}`),
    ].join('\n');

    function writeBlock(showAllToolOutput: boolean) {
      return withTheme(
        asTarget(
          'call-create',
          <ToolCallBlock
            toolId="call-create"
            name="Write"
            args={{ filePath: 'src/new.ts' }}
            result={successResult('call-create', newFileDiff, {
              kind: 'create',
              filePath: 'src/new.ts',
              addedLines: 150,
              removedLines: 0,
            })}
            isExpanded
            showAllToolOutput={showAllToolOutput}
            reducedMotion
          />,
        ),
      );
    }

    it('previews only the first 10 lines of a new file', () => {
      const view = render(writeBlock(false));
      const rendered = frame(view.lastFrame);
      const contentRows = rendered.split('\n').filter((row) => /\+ line \d+/.test(row));

      expect(contentRows).toHaveLength(10);
      expect(rendered).toContain('+ line 1');
      expect(rendered).toContain('+ line 10');
      expect(rendered).not.toContain('+ line 11');
      expect(rendered).not.toContain('@@');
      expect(rendered).toContain('… +140 lines (Ctrl+E)');
    });

    it('shows the whole new file under show-all', () => {
      const view = render(writeBlock(true));
      const rendered = frame(view.lastFrame);
      const contentRows = rendered.split('\n').filter((row) => /\+ line \d+/.test(row));

      expect(contentRows).toHaveLength(150);
      expect(rendered).toContain('+ line 150');
      expect(rendered).not.toContain('… +');
    });

    const longEditOutput = [
      '@@ -1,100 +1,100 @@',
      ...Array.from({ length: 100 }, (_, index) => `-old ${index + 1}`),
      ...Array.from({ length: 100 }, (_, index) => `+new ${index + 1}`),
    ].join('\n');

    function editBlock(
      props: { transcriptMode?: 'compact' | 'detailed'; showAllToolOutput?: boolean } = {},
    ) {
      return withTheme(
        asTarget(
          'call-edit-long',
          <ToolCallBlock
            toolId="call-edit-long"
            name="Edit"
            args={{ filePath: 'src/a.ts' }}
            result={successResult('call-edit-long', longEditOutput, {
              kind: 'update',
              filePath: 'src/a.ts',
              addedLines: 100,
              removedLines: 100,
            })}
            isExpanded
            reducedMotion
            {...props}
          />,
        ),
      );
    }

    it('previews the first 20 rows of an Edit diff in the compact transcript', () => {
      const rendered = frame(render(editBlock()).lastFrame);
      const contentRows = rendered.split('\n').filter((row) => /[-+] (old|new) \d+/.test(row));

      expect(contentRows).toHaveLength(20);
      expect(rendered).toContain('- old 20');
      expect(rendered).not.toContain('- old 21');
      expect(rendered).not.toContain('@@');
      expect(rendered).not.toContain('lines omitted');
      expect(rendered).toContain('… +180 lines (Ctrl+E)');
    });

    it('keeps the change-focused 80-row preview in the detailed transcript', () => {
      const rendered = frame(render(editBlock({ transcriptMode: 'detailed' })).lastFrame);
      const contentRows = rendered.split('\n').filter((row) => /[-+] (old|new) \d+/.test(row));

      // One hunk draws no header: 79 content lines, one gap row, then the footer.
      expect(contentRows).toHaveLength(79);
      expect(rendered).toContain('- old 40');
      expect(rendered).not.toContain('- old 41');
      expect(rendered).toContain('+ new 100');
      expect(rendered).not.toContain('+ new 50');
      expect(rendered).toContain('… 121 lines hidden (Ctrl+E)');
      expect(rendered).not.toContain('… +');
      expect(rendered).toContain('⋮ 121 lines omitted');
    });

    it('shows the whole Edit diff under show-all, whatever the transcript mode', () => {
      for (const transcriptMode of ['compact', 'detailed'] as const) {
        const rendered = frame(
          render(editBlock({ transcriptMode, showAllToolOutput: true })).lastFrame,
        );
        const contentRows = rendered.split('\n').filter((row) => /[-+] (old|new) \d+/.test(row));

        expect(contentRows).toHaveLength(200);
        expect(rendered).not.toContain('… +');
        expect(rendered).not.toContain('lines omitted');
        cleanup();
      }
    });

    it('previews a compact Edit rename as 20 rows with its true remainder in the footer', () => {
      const output = [
        '@@ -1 +1 @@',
        ...Array.from({ length: 6 }, (_, index) => ` before ${index + 1}`),
        ...Array.from({ length: 12 }, (_, index) => `-const oldName${index} = 1;`),
        ...Array.from({ length: 12 }, (_, index) => `+const newName${index} = 1;`),
        ...Array.from({ length: 9 }, (_, index) => ` after ${index + 1}`),
      ].join('\n');
      const view = render(
        withTheme(
          asTarget(
            'call-rename',
            <ToolCallBlock
              toolId="call-rename"
              name="Edit"
              args={{ filePath: 'src/a.ts', replaceAll: true }}
              result={successResult('call-rename', output, {
                kind: 'update',
                filePath: 'src/a.ts',
                addedLines: 12,
                removedLines: 12,
              })}
              isExpanded
              reducedMotion
            />,
          ),
        ),
      );
      const rendered = frame(view.lastFrame);

      expect(rendered.split('\n').filter((row) => row.includes('│'))).toHaveLength(21);
      expect(rendered).toContain('… +19 lines (Ctrl+E)');
    });

    it('renders a multi-file creation with real file headers and no head preview', () => {
      const fileBlock = (name: string) => [
        `--- ${name}`,
        `+++ ${name}`,
        '@@ -0,0 +1,15 @@',
        ...Array.from({ length: 15 }, (_, index) => `+${name} line ${index + 1}`),
      ];
      const output = [...fileBlock('a.js'), ...fileBlock('b.js')].join('\n');
      const result: ToolResult = {
        version: 2,
        toolCallId: 'call-multi-create',
        status: 'success',
        content: output,
        artifacts: {
          fileMutations: ['a.js', 'b.js'].map((filePath) => ({
            kind: 'create' as const,
            filePath,
            addedLines: 15,
            removedLines: 0,
          })),
        },
      };
      const view = render(
        withTheme(
          <ToolCallBlock
            name="ApplyPatch"
            args={{}}
            result={result}
            isExpanded
            reducedMotion
            transcriptMode="detailed"
          />,
        ),
      );
      const rendered = frame(view.lastFrame);

      expect(rendered).toContain('--- b.js');
      expect(rendered).toContain('+++ b.js');
      expect(rendered).not.toMatch(/[-+] [-+]{2} b\.js/);
      expect(rendered).not.toMatch(/[-+] [-+]{2} a\.js/);
      // All 30 lines fit the change-focused budget, so there is no head cut.
      expect(rendered).toContain('+ b.js line 15');
      expect(rendered).not.toContain('lines (Ctrl+E)');
      expect(rendered).not.toContain('lines hidden');
    });

    it('shares one 20-row compact budget across the files of one call', () => {
      const fileBlock = (name: string) => [
        `--- ${name}`,
        `+++ ${name}`,
        '@@ -0,0 +1,15 @@',
        ...Array.from({ length: 15 }, (_, index) => `+${name} line ${index + 1}`),
      ];
      const result: ToolResult = {
        version: 2,
        toolCallId: 'call-multi-compact',
        status: 'success',
        content: [...fileBlock('a.js'), ...fileBlock('b.js')].join('\n'),
        artifacts: {
          fileMutations: ['a.js', 'b.js'].map((filePath) => ({
            kind: 'create' as const,
            filePath,
            addedLines: 15,
            removedLines: 0,
          })),
        },
      };
      const view = render(
        withTheme(
          asTarget(
            'call-multi-compact',
            <ToolCallBlock
              toolId="call-multi-compact"
              name="ApplyPatch"
              args={{}}
              result={result}
              isExpanded
              reducedMotion
            />,
          ),
        ),
      );
      const rendered = frame(view.lastFrame);

      // Each file has one hunk, so neither draws a header. a.js takes 17 rows (two file headers,
      // 15 lines); b.js gets its two file headers and its first line.
      expect(rendered).not.toContain('@@');
      expect(rendered).toContain('+ a.js line 15');
      expect(rendered).toContain('--- b.js');
      expect(rendered).toContain('+++ b.js');
      expect(rendered).toContain('+ b.js line 1');
      expect(rendered).not.toContain('b.js line 2');
      expect(rendered).toContain('… +14 lines (Ctrl+E)');
    });

    it('drops the file metadata rows of a single-file ApplyPatch preview', () => {
      const result: ToolResult = {
        version: 2,
        toolCallId: 'call-single-patch',
        status: 'success',
        content: [
          '--- src/a.ts',
          '+++ src/a.ts',
          '@@ -4 +4 @@',
          '-const a = 1;',
          '+const a = 2;',
        ].join('\n'),
        artifacts: {
          fileMutations: [
            { kind: 'update' as const, filePath: 'src/a.ts', addedLines: 1, removedLines: 1 },
          ],
        },
      };
      const view = render(
        withTheme(
          <ToolCallBlock name="ApplyPatch" args={{}} result={result} isExpanded reducedMotion />,
        ),
      );
      const rendered = frame(view.lastFrame);

      expect(rendered).toContain('+ const a = 2;');
      expect(rendered).not.toContain('--- src/a.ts');
      expect(rendered).not.toContain('+++ src/a.ts');
      expect(rendered).not.toContain('@@');
    });
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
    expect(rendered).toMatch(/Edit\s+analysis\.ipynb\s+\+1 -1$/m);
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
    expect(rendered).toMatch(/Create\s+src\/new-file\.txt\s+\+2$/m);
    expect(rendered.split('\n')).toHaveLength(1);
  });

  it('wraps complete created-file diff lines when expanded under show-all', () => {
    const content = `start-${'x'.repeat(80)}-created-end`;
    const width = 42;
    const view = render(
      withTheme(
        <ToolCallBlock
          name="Write"
          args={{ filePath: 'src/new-file.txt' }}
          result={successResult('call-create-wrap', `@@ -0,0 +1 @@\n+${content}`, {
            kind: 'create',
            filePath: 'src/new-file.txt',
            addedLines: 1,
            removedLines: 0,
          })}
          isExpanded
          showAllToolOutput
          reducedMotion
          terminalWidth={width}
        />,
      ),
    );

    const rendered = frame(view.lastFrame);
    expect(rendered).toContain('start-');
    expect(rendered).toContain('d-end');
    expect(rendered).not.toContain('…');
    // Assert the content survives the wrap, not where the wrap lands: the
    // break position moves with the rail's column budget, the completeness
    // must not.
    const diffRows = rendered.split('\n').filter((line) => line.includes('│'));
    const diffText = diffRows.map((line) => line.slice(line.lastIndexOf('│') + 1).trim()).join('');
    expect(diffText).toContain(content);
    expect(diffText.match(/x/g)).toHaveLength(80);
    for (const line of rendered.split('\n')) expect(displayWidth(line)).toBeLessThanOrEqual(width);
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
    expect(rendered).toMatch(/Edit\s+src\/broken\.ts/);
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

    // `Shell output` and `Kill shell` are shortened to fit the label column.
    expect(frame(outputView.lastFrame)).toMatch(/Shell\s+shell_1/);
    expect(frame(killView.lastFrame)).toMatch(/Kill shell\s+shell_1/);
  });

  it('bounds expanded output, summaries, and errors to a narrow width', () => {
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

  it('shows the reason of a network-policy refusal but keeps other skipped rows quiet', () => {
    const policy = render(
      withTheme(
        <ToolCallBlock
          name="WebFetch"
          args={{ url: 'https://localhost/' }}
          result={{
            version: 2,
            toolCallId: 'call-policy',
            status: 'blocked',
            content: '',
            structuredError: {
              code: 'private_network_forbidden',
              message: 'Web fetch blocked because localhost resolves to private address 127.0.0.1.',
              retryable: false,
            },
          }}
          isExpanded={false}
          reducedMotion
        />,
      ),
    );
    expect(frame(policy.lastFrame)).toContain('Web fetch blocked because localhost');

    const inactive = render(
      withTheme(
        <ToolCallBlock
          name="WebFetch"
          args={{ url: 'https://example.com/' }}
          result={{
            version: 2,
            toolCallId: 'call-inactive',
            status: 'blocked',
            content: '',
            structuredError: {
              code: 'tool_not_active',
              message: 'WebFetch is not active; call ToolSearch first.',
              retryable: false,
            },
          }}
          isExpanded={false}
          reducedMotion
        />,
      ),
    );
    expect(frame(inactive.lastFrame)).not.toContain('is not active');
  });

  it('shows why a cross-origin redirect was stopped', () => {
    // The redirect target may be a private host the model never asked for; the row says the fetch
    // stopped at the origin change rather than showing a bare skip.
    const view = render(
      withTheme(
        <ToolCallBlock
          name="WebFetch"
          args={{ url: 'https://example.com/start' }}
          result={{
            version: 2,
            toolCallId: 'call-redirect',
            status: 'blocked',
            content: '',
            structuredError: {
              code: 'cross_origin_redirect',
              message:
                'Redirect from https://example.com/start to a different origin requires a new WebFetch approval.',
              retryable: false,
            },
          }}
          isExpanded={false}
          terminalWidth={200}
          reducedMotion
        />,
      ),
    );
    expect(frame(view.lastFrame)).toContain('Redirect from');
  });

  it('shows the reason of a WebSearch whose every provider was refused', () => {
    const view = render(
      withTheme(
        <ToolCallBlock
          name="WebSearch"
          args={{ query: 'anything' }}
          result={{
            version: 2,
            toolCallId: 'call-search',
            status: 'blocked',
            content: '',
            structuredError: {
              code: 'search_all_providers_failed',
              message:
                'Built-in web search providers are unavailable. exa: Connection blocked because mcp.exa.ai resolved to private or special-use address 127.0.0.1.',
              retryable: false,
            },
          }}
          isExpanded={false}
          reducedMotion
        />,
      ),
    );

    expect(frame(view.lastFrame)).toContain('Built-in web search providers are unavailable');
  });

  it('renders summary as exactly one line ending in … at narrow width with long target', () => {
    const width = 24;
    const view = render(
      withTheme(
        <Box width={width}>
          <ToolCallBlock
            name="Bash"
            args={{ command: 'git log --oneline --graph --all --decorate --stat' }}
            result={successResult('call-narrow', 'ok')}
            isExpanded={false}
            terminalWidth={width}
            reducedMotion
          />
        </Box>,
      ),
    );

    const rendered = frame(view.lastFrame);
    const lines = rendered.split('\n').filter((line) => line.trim().length > 0);
    expect(lines).toHaveLength(1);
    expect(lines[0]!.trimEnd()).toMatch(/…$/);
  });
});

/** The truecolor escape chalk writes for a `#RRGGBB` token. */
function rgb(token: string): string {
  const [r, g, b] = [1, 3, 5].map((offset) => parseInt(token.slice(offset, offset + 2), 16)) as [
    number,
    number,
    number,
  ];
  return `\u001b[38;2;${r};${g};${b}m`;
}

/** Render with truecolor forced, so the ink each part is set in shows in the frame. */
function colourFrame(element: React.ReactElement): string {
  const level = chalk.level;
  chalk.level = 3;
  try {
    return render(withTheme(element)).lastFrame() ?? '';
  } finally {
    chalk.level = level;
  }
}

describe('ToolCallBlock failures', () => {
  const MESSAGE =
    'Invalid arguments for TodoWrite: arguments.todos is required. Allowed arguments: todos.';

  it('lays the message out under the row, whole, instead of cutting it to the meta column', () => {
    // The row used to read `× Steps   Invalid arguments for TodoWrite: arguments.todos is required. A…`.
    const view = render(
      withTheme(
        <ToolCallBlock
          name="Bash"
          args={{ command: 'npm test' }}
          result={failureResult('call-1', MESSAGE)}
          isExpanded={false}
          terminalWidth={80}
          reducedMotion
        />,
      ),
    );
    const lines = frame(view.lastFrame)
      .split('\n')
      .filter((line) => line.trim().length > 0);

    expect(lines[0]).toMatch(/Bash\s+npm test/);
    expect(lines[0]).not.toContain('Invalid arguments');
    expect(
      lines
        .slice(1)
        .map((line) => line.trim())
        .join(' '),
    ).toBe(MESSAGE);
    for (const line of lines) expect(displayWidth(line)).toBeLessThanOrEqual(80);
  });

  describe('memory files', () => {
    const MEMORY = '/home/u/.book/projects/p/memory';
    const memory = memoryRootDisplay({ roots: [MEMORY], platform: 'linux' });
    const notes = `${MEMORY}/notes.md`;

    function firstLine(element: React.ReactElement): string {
      const view = render(withTheme(element));
      return frame(view.lastFrame)
        .split('\n')
        .find((line) => line.trim().length > 0)!;
    }

    function inMemory(element: React.ReactElement): React.ReactElement {
      return <MemoryRootContext.Provider value={memory}>{element}</MemoryRootContext.Provider>;
    }

    it('names a failed edit, which has no result path, `memory/<file>`', () => {
      const row = (
        <ToolCallBlock
          name="Edit"
          args={{ filePath: notes, oldString: 'a', newString: 'b' }}
          result={enrichToolResultPresentation(
            toolFailure(`${notes} has not been read in this session.`, {
              code: 'file_not_observed',
            }),
            'Edit',
            { filePath: notes },
          )}
          isExpanded={false}
          terminalWidth={120}
          reducedMotion
        />
      );

      expect(firstLine(inMemory(row))).toMatch(/Edit\s+memory\/notes/);
      expect(firstLine(inMemory(row))).not.toContain('/home/u');
      // Without the provider the row keeps the path the model wrote.
      expect(firstLine(row)).toContain('/home/u/.book/projects/p/memory/');
    });

    it('names a running read `memory/<file>`', () => {
      const row = (
        <ToolCallBlock
          name="Read"
          args={{ filePath: notes }}
          isPending
          isExpanded={false}
          terminalWidth={120}
          reducedMotion
        />
      );

      expect(firstLine(inMemory(row))).toMatch(/Read\s+memory\/notes/);
    });
  });

  it('greys a call the registry refused before it ran', () => {
    const raw = colourFrame(
      <ToolCallBlock
        name="TodoWrite"
        args={{}}
        result={enrichToolResultPresentation(
          toolFailure(MESSAGE, { code: 'invalid_arguments', details: { preExecution: true } }),
          'TodoWrite',
          {},
        )}
        isExpanded={false}
        terminalWidth={100}
        reducedMotion
      />,
    );

    expect(raw).toContain(`${rgb(DEFAULT_THEME.inactive)}×`);
    expect(raw).not.toContain(rgb(DEFAULT_THEME.error));
    expect(stripAnsi(raw)).toContain('arguments.todos is required');
  });

  it('keeps a call that ran and failed in rose', () => {
    // A test run that exits 1 is the transcript's only record of a red suite.
    const raw = colourFrame(
      <ToolCallBlock
        name="Bash"
        args={{ command: 'npm test' }}
        result={failureResult('call-1', 'Exit code: 1')}
        isExpanded={false}
        terminalWidth={100}
        reducedMotion
      />,
    );

    expect(raw).toContain(`${rgb(DEFAULT_THEME.error)}×`);
    expect(raw).toContain(`${rgb(DEFAULT_THEME.error)}Exit code: 1`);
  });

  it('shows the exit code and the tail of a long failure, behind a count of what was cut', () => {
    const stderr = Array.from(
      { length: 40 },
      (_, i) =>
        `error: assertion ${i + 1} failed in test/case_${i + 1}.test.js: expected 200, got 500`,
    ).join('\n');
    const result = enrichToolResultPresentation(
      {
        ...toolFailure(stderr, { details: { exitCode: 1 } }),
        metrics: { durationMs: 7 },
      },
      'Bash',
      { command: 'bash scripts/fail.sh' },
    );
    const raw = colourFrame(
      asTarget(
        'fail-1',
        <ToolCallBlock
          toolId="fail-1"
          name="Bash"
          args={{ command: 'bash scripts/fail.sh' }}
          result={result}
          isExpanded={false}
          terminalWidth={100}
          reducedMotion
        />,
      ),
    );
    const rendered = stripAnsi(raw);
    const lines = rendered.split('\n').filter((line) => line.trim().length > 0);

    expect(lines[0]).toMatch(/failed · exit 1 · 7ms/);
    expect(lines.slice(1).map((line) => line.trim())).toEqual([
      '… +36 lines (Ctrl+E)',
      'error: assertion 37 failed in test/case_37.test.js: expected 200, got 500',
      'error: assertion 38 failed in test/case_38.test.js: expected 200, got 500',
      'error: assertion 39 failed in test/case_39.test.js: expected 200, got 500',
      'error: assertion 40 failed in test/case_40.test.js: expected 200, got 500',
    ]);
    expect(rendered).not.toContain('assertion 1 failed');
    expect(raw).toContain(`${rgb(DEFAULT_THEME.inactive)}… +36 lines (Ctrl+E)`);
    expect(raw).toContain(`${rgb(DEFAULT_THEME.error)}error: assertion 40`);
  });

  it('shows every line of the failure once the row is shown in full, with no hint', () => {
    const stderr = Array.from(
      { length: 40 },
      (_, i) =>
        `error: assertion ${i + 1} failed in test/case_${i + 1}.test.js: expected 200, got 500`,
    );
    const result = enrichToolResultPresentation(
      {
        ...toolFailure(stderr.join('\n'), { details: { exitCode: 1 } }),
        metrics: { durationMs: 7 },
      },
      'Bash',
      { command: 'bash scripts/fail.sh' },
    );
    const rendered = stripAnsi(
      colourFrame(
        <ToolCallBlock
          name="Bash"
          args={{ command: 'bash scripts/fail.sh' }}
          result={result}
          isExpanded
          showAllToolOutput
          terminalWidth={100}
          reducedMotion
        />,
      ),
    );
    const lines = rendered.split('\n').filter((line) => line.trim().length > 0);

    expect(lines[0]).toMatch(/failed · exit 1 · 7ms/);
    expect(lines.slice(1).map((line) => line.trim())).toEqual(stderr);
    expect(rendered).not.toContain('Ctrl+E');
    expect(rendered).not.toContain('… +');
  });

  it('folds the whole error back to its tail when the row is no longer expanded', () => {
    const stderr = Array.from(
      { length: 40 },
      (_, i) =>
        `error: assertion ${i + 1} failed in test/case_${i + 1}.test.js: expected 200, got 500`,
    );
    const result = enrichToolResultPresentation(
      toolFailure(stderr.join('\n'), { details: { exitCode: 1 } }),
      'Bash',
      { command: 'bash scripts/fail.sh' },
    );
    const rendered = stripAnsi(
      colourFrame(
        asTarget(
          'fail-1',
          <ToolCallBlock
            toolId="fail-1"
            name="Bash"
            args={{ command: 'bash scripts/fail.sh' }}
            result={result}
            isExpanded={false}
            showAllToolOutput
            terminalWidth={100}
            reducedMotion
          />,
        ),
      ),
    );
    const lines = rendered
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .slice(1)
      .map((line) => line.trim());

    expect(lines).toEqual(['… +36 lines (Ctrl+E)', ...stderr.slice(-4)]);
  });

  it('draws the stdout of a command with no stderr once when the row is expanded in full', () => {
    const stdout = Array.from({ length: 12 }, (_, i) => `FAIL test/case_${i + 1}.test.js`).join(
      '\n',
    );
    const result = enrichToolResultPresentation(
      toolFailure('Exit code: 1', { content: stdout, details: { exitCode: 1 } }),
      'Bash',
      { command: 'npm test' },
    );
    const draw = (isExpanded: boolean) =>
      stripAnsi(
        colourFrame(
          asTarget(
            'npm-1',
            <ToolCallBlock
              toolId="npm-1"
              name="Bash"
              args={{ command: 'npm test' }}
              result={result}
              isExpanded={isExpanded}
              showAllToolOutput
              terminalWidth={100}
              reducedMotion
            />,
          ),
        ),
      );
    const rendered = draw(true);

    for (let i = 1; i <= 12; i++) {
      expect(rendered.split(`FAIL test/case_${i}.test.js`)).toHaveLength(2);
    }
    expect(rendered).not.toContain('… +');
    // Folded back, only the collapsed tail is left, and the output block is gone.
    const folded = draw(false);
    expect(folded).toContain('… +8 lines (Ctrl+E)');
    expect(folded).not.toContain('FAIL test/case_1.test.js');
  });

  it('continues a long expanded error line on the rows after it', () => {
    const long = `error: ${'0123456789'.repeat(18)}`;
    const result = enrichToolResultPresentation(
      toolFailure(long, { details: { exitCode: 1 } }),
      'Bash',
      { command: 'make' },
    );
    const rendered = stripAnsi(
      colourFrame(
        <ToolCallBlock
          name="Bash"
          args={{ command: 'make' }}
          result={result}
          isExpanded
          showAllToolOutput
          terminalWidth={100}
          reducedMotion
        />,
      ),
    );
    const detail = rendered
      .split('\n')
      .slice(1)
      .map((line) => line.trim())
      .filter(Boolean);

    expect(detail.length).toBeGreaterThan(1);
    expect(detail.join('')).toBe(long);
    expect(rendered).not.toContain('…');
  });

  describe('click expansion', () => {
    const register = (result: ToolResult, command: string) => {
      const registrations: Array<{ expandable: boolean; expanded: boolean }> = [];
      colourFrame(
        <ToolRowInteractionContext.Provider
          value={{
            register: (registration) => {
              registrations.push(registration);
              return () => undefined;
            },
          }}
        >
          <ToolCallBlock
            toolId="call-1"
            name="Bash"
            args={{ command }}
            result={result}
            isExpanded={false}
            terminalWidth={100}
            reducedMotion
          />
        </ToolRowInteractionContext.Provider>,
      );
      return registrations.at(-1);
    };
    const stderr = (count: number) =>
      Array.from({ length: count }, (_, i) => `error: line ${i + 1}`).join('\n');
    const failed = (message: string) =>
      enrichToolResultPresentation(toolFailure(message, { details: { exitCode: 1 } }), 'Bash', {
        command: 'make',
      });

    it('registers a stderr-only failure with hidden lines as expandable', () => {
      expect(register(failed(stderr(12)), 'make')?.expandable).toBe(true);
    });

    it('does not register a failure whose lines all show', () => {
      expect(register(failed(stderr(3)), 'make')?.expandable).toBe(false);
    });
  });

  it('shows the stdout verdict of a command that said nothing on stderr', () => {
    const stdout = Array.from({ length: 12 }, (_, i) => `FAIL test/case_${i + 1}.test.js`).join(
      '\n',
    );
    const result = enrichToolResultPresentation(
      {
        ...toolFailure('Exit code: 1', { content: stdout, details: { exitCode: 1 } }),
        metrics: { durationMs: 7 },
      },
      'Bash',
      { command: 'npm test' },
    );
    const raw = colourFrame(
      asTarget(
        'npm-1',
        <ToolCallBlock
          toolId="npm-1"
          name="Bash"
          args={{ command: 'npm test' }}
          result={result}
          isExpanded={false}
          terminalWidth={100}
          reducedMotion
        />,
      ),
    );
    const rendered = stripAnsi(raw);
    const lines = rendered.split('\n').filter((line) => line.trim().length > 0);

    expect(lines[0]).toMatch(/failed · exit 1 · 7ms/);
    expect(lines[0]).not.toMatch(/12 lines/);
    expect(lines.slice(1).map((line) => line.trim())).toEqual([
      '… +8 lines (Ctrl+E)',
      'FAIL test/case_9.test.js',
      'FAIL test/case_10.test.js',
      'FAIL test/case_11.test.js',
      'FAIL test/case_12.test.js',
    ]);
    expect(lines.slice(1).join('\n')).not.toContain('Exit code: 1');
    expect(raw).toContain(`${rgb(DEFAULT_THEME.error)}FAIL test/case_12`);
  });

  it('shows no detail rows for a command that failed with no output at all', () => {
    const result = toolFailure('Exit code: 3', { details: { exitCode: 3 } });
    const rendered = stripAnsi(
      colourFrame(
        <ToolCallBlock
          name="Bash"
          args={{ command: 'false' }}
          result={result}
          isExpanded={false}
          terminalWidth={100}
          reducedMotion
        />,
      ),
    );
    const lines = rendered.split('\n').filter((line) => line.trim().length > 0);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/failed · exit 3/);
  });

  it('keeps the first line of a multi-line failure that is not command output', () => {
    const message = 'MCP tool x failed: connection refused\n(stderr: dial tcp 127.0.0.1:1)';
    const rendered = stripAnsi(
      colourFrame(
        <ToolCallBlock
          name="mcp__x__search"
          args={{}}
          result={toolFailure(message)}
          isExpanded={false}
          terminalWidth={100}
          reducedMotion
        />,
      ),
    );
    expect(rendered).toContain('MCP tool x failed: connection refused');
  });

  it('draws the sandbox note after the tail, in the error colour', () => {
    const message = `fatal: Unable to create index.lock\nNote: run it outside the sandbox.`;
    const raw = colourFrame(
      <ToolCallBlock
        name="Bash"
        args={{ command: 'git add .' }}
        result={toolFailure(message, { details: { exitCode: 128 } })}
        isExpanded={false}
        terminalWidth={100}
        reducedMotion
      />,
    );
    const lines = stripAnsi(raw)
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    expect(lines.slice(1)).toEqual([
      'fatal: Unable to create index.lock',
      'Note: run it outside the sandbox.',
    ]);
    expect(raw).toContain(`${rgb(DEFAULT_THEME.error)}Note: run it outside`);
  });
});

describe('ToolCallBlock plan rows', () => {
  function planFrame(statuses: string[]): string {
    const todos = statuses.map((status, index) => ({
      content: `Step ${index + 1}`,
      status,
      activeForm: `Doing step ${index + 1}`,
    }));
    return stripAnsi(
      colourFrame(
        <ToolCallBlock
          name="TodoWrite"
          args={{ todos }}
          result={enrichToolResultPresentation(toolSuccess('Todos updated.'), 'TodoWrite', {
            todos,
          })}
          isExpanded={false}
          terminalWidth={100}
          reducedMotion
        />,
      ),
    );
  }

  it('marks a plan under way rather than checking it', () => {
    // `✓ Steps  Clone vibe-coding repo into workspace   0 of 3 done` read as a step done.
    const rendered = planFrame(['in_progress', 'pending', 'pending']);
    expect(rendered).toMatch(/◔ Steps\s+Step 1\s+0 of 3 done/);
    expect(rendered).not.toContain('✓');
  });

  it('marks a plan set out and not begun', () => {
    expect(planFrame(['pending', 'pending'])).toMatch(/◌ Steps/);
  });

  it('checks a finished plan', () => {
    expect(planFrame(['completed', 'completed'])).toMatch(/✓ Steps\s+2 of 2 done/);
  });
});

describe('ToolCallBlock Ctrl+E hint', () => {
  const rows = workloadRows();
  const byId = (id: string) => rows.find((row) => row.call.id === id)!;

  function renderRow(
    id: string,
    props: {
      target?: string | null;
      transcriptMode?: 'compact' | 'detailed';
      isExpanded?: boolean;
    } = {},
  ): string {
    const row = byId(id);
    const { target, transcriptMode = 'compact' } = props;
    const isExpanded = props.isExpanded ?? shouldDefaultExpandTool(row.call.name, row.result);
    const block = (
      <ToolCallBlock
        toolId={row.call.id}
        name={row.call.name}
        args={row.call.arguments}
        result={row.result}
        isExpanded={isExpanded}
        transcriptMode={transcriptMode}
        terminalWidth={100}
        reducedMotion
      />
    );
    return frame(
      render(
        withTheme(
          target === undefined ? (
            block
          ) : (
            <ToolExpandTargetContext.Provider value={target}>
              {block}
            </ToolExpandTargetContext.Provider>
          ),
        ),
      ).lastFrame,
    );
  }

  it.each([
    ['a diff', 'write-new', '… +140 lines'],
    ['a capped edit', 'edit-long', '… +180 lines'],
    ['a failed command', 'bash-fail', '… +36 lines'],
  ])('drops the key from %s footer when another row is the target', (_name, id, footer) => {
    const rendered = renderRow(id, { target: 'some-other-row' });
    expect(rendered).toContain(footer);
    expect(rendered).not.toContain('Ctrl+E');
  });

  it('drops the key from an output footer when another row is the target', () => {
    const output = Array.from({ length: 8 }, (_, i) => `line ${i + 1}`).join('\n');
    const render1 = (target: string) =>
      frame(
        render(
          withTheme(
            <ToolExpandTargetContext.Provider value={target}>
              <ToolCallBlock
                toolId="out-1"
                name="Bash"
                args={{ command: 'seq 8' }}
                result={successResult('out-1', output)}
                isExpanded
                reducedMotion
              />
            </ToolExpandTargetContext.Provider>,
          ),
        ).lastFrame,
      );
    expect(render1('other')).toContain('… +2 lines');
    expect(render1('other')).not.toContain('Ctrl+E');
    expect(render1('out-1')).toContain('… +2 lines (Ctrl+E)');
  });

  it.each([
    ['a diff', 'write-new', '… +140 lines (Ctrl+E)'],
    ['a capped edit', 'edit-long', '… +180 lines (Ctrl+E)'],
    ['a failed command', 'bash-fail', '… +36 lines (Ctrl+E)'],
  ])('names the key in %s footer when the row is the target', (_name, id, footer) => {
    expect(renderRow(id, { target: id })).toContain(footer);
  });

  it('names no key in the compact transcript outside a provider', () => {
    // With no provider nothing says Ctrl+E acts on this row, so it must not claim the key.
    const rendered = renderRow('write-new');
    expect(rendered).toContain('… +140 lines');
    expect(rendered).not.toContain('Ctrl+E');
  });

  it('names the key in the detailed transcript outside a provider', () => {
    const rendered = renderRow('write-new', { transcriptMode: 'detailed', isExpanded: true });
    expect(rendered).toContain('(Ctrl+E)');
  });

  it('names no key when the target is null', () => {
    expect(renderRow('write-new', { target: null })).not.toContain('Ctrl+E');
  });

  it.each([
    ['write-new', '… +'],
    ['bash-fail', '… +36 lines (Ctrl+E)'],
  ])('keeps the key on %s in the detailed transcript whoever the target is', (id, footer) => {
    const rendered = renderRow(id, {
      target: 'some-other-row',
      transcriptMode: 'detailed',
      isExpanded: true,
    });
    expect(rendered).toContain(footer);
    expect(rendered).toContain('(Ctrl+E)');
  });

  it("agrees with the target's predicate: a footer is drawn exactly where a row hides content", () => {
    const output = Array.from({ length: 30 }, (_, i) => `row ${i}`).join('\n');
    const extra = [
      { id: 'bash-long', content: output, expanded: true },
      { id: 'bash-short', content: 'a\nb', expanded: true },
      { id: 'bash-folded', content: output, expanded: false },
    ].map(({ id, content, expanded }) => ({
      call: { id, name: 'Bash', arguments: { command: 'cmd' } },
      result: successResult(id, content),
      expanded,
    }));
    const cases = [
      ...rows.map((row) => ({
        call: row.call,
        result: row.result,
        expanded: shouldDefaultExpandTool(row.call.name, row.result),
      })),
      ...extra,
    ];
    for (const { call, result, expanded } of cases) {
      const rendered = frame(
        render(
          withTheme(
            <ToolCallBlock
              toolId={call.id}
              name={call.name}
              args={call.arguments}
              result={result}
              isExpanded={expanded}
              transcriptMode="compact"
              terminalWidth={100}
              reducedMotion
            />,
          ),
        ).lastFrame,
      );
      const hides = toolRowHidesContent({
        name: call.name,
        args: call.arguments,
        result,
        isExpanded: expanded,
        transcriptMode: 'compact',
        terminalWidth: 100,
        showAllToolOutput: false,
      });
      expect([call.id, rendered.includes('… +')]).toEqual([call.id, hides]);
    }
  });
});
