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
    // One item mark, and no check, cross, tree or disclosure glyph anywhere.
    expect(rendered.match(/●/g)).toHaveLength(1);
    expect(rendered).not.toMatch(/[✓×╰├›⌄]/);
  });

  it('says a running call is running, and blinks its mark once a second', () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const level = chalk.level;
    chalk.level = 3;
    try {
      const view = render(
        withTheme(<ToolCallBlock name="Bash" args={{ command: 'npm test' }} isExpanded />),
      );
      expect(frame(view.lastFrame)).toBe('● Bash(npm test)\n  ⎿  Running…');
      const before = view.lastFrame();
      void act(() => vi.advanceTimersByTime(1000));
      // The text holds still; only the mark's colour changes. No elapsed time is drawn.
      expect(view.lastFrame()).not.toBe(before);
      expect(frame(view.lastFrame)).toBe('● Bash(npm test)\n  ⎿  Running…');
    } finally {
      chalk.level = level;
    }
  });

  it('holds a running mark still under reduced motion', () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const level = chalk.level;
    chalk.level = 3;
    try {
      const view = render(
        withTheme(
          <ToolCallBlock name="Bash" args={{ command: 'npm test' }} isExpanded reducedMotion />,
        ),
      );
      const before = view.lastFrame();
      void act(() => vi.advanceTimersByTime(2500));
      expect(view.lastFrame()).toBe(before);
    } finally {
      chalk.level = level;
    }
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
    expect(rendered).toContain('● Bash(npm test)');
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

  it('renders an Update(filePath) item that says its change in words', () => {
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
    expect(rendered.split('\n')).toEqual([
      '● Update(src/tui/components/Diff.tsx)',
      '  ⎿  Added 2 lines, removed 1 line',
    ]);
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

    it('previews only the first 5 lines of a new file', () => {
      const view = render(writeBlock(false));
      const rendered = frame(view.lastFrame);
      const contentRows = rendered.split('\n').filter((row) => /\+ line \d+/.test(row));

      expect(rendered).toContain('● Write(src/new.ts)');
      expect(rendered).toContain('⎿  Wrote 150 lines');
      expect(contentRows).toHaveLength(5);
      expect(rendered).toContain('+ line 1');
      expect(rendered).toContain('+ line 5');
      expect(rendered).not.toContain('+ line 6');
      expect(rendered).not.toContain('@@');
      expect(rendered).toContain('… +145 lines (Ctrl+E)');
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

    it('previews an Edit diff within the 12-row compact budget, first and last changes kept', () => {
      const rendered = frame(render(editBlock()).lastFrame);
      const contentRows = rendered.split('\n').filter((row) => /[-+] (old|new) \d+/.test(row));

      // The changes alone overflow the budget: the first six and the last five, around one gap.
      expect(contentRows).toHaveLength(11);
      expect(rendered).toContain('- old 6');
      expect(rendered).not.toContain('- old 7');
      expect(rendered).toContain('+ new 96');
      expect(rendered).toContain('+ new 100');
      expect(rendered).not.toContain('@@');
      expect(rendered).toContain('⋮ 189 lines omitted');
      expect(rendered).toContain('… 189 lines hidden (Ctrl+E)');
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

    it('previews a compact Edit rename within its budget, with its true remainder in the footer', () => {
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
      const rows = resultRows(rendered);

      // The 24 changed lines overflow the 12-row budget: the first and last of them around one
      // gap row, which the budget counts, then the footer with the true remainder.
      expect(rows).toEqual([
        'Added 12 lines, removed 12 lines',
        ' 7 - const oldName0 = 1;',
        ' 8 - const oldName1 = 1;',
        ' 9 - const oldName2 = 1;',
        '10 - const oldName3 = 1;',
        '11 - const oldName4 = 1;',
        ' ⋮ 14 lines omitted',
        '14 + const newName7 = 1;',
        '15 + const newName8 = 1;',
        '16 + const newName9 = 1;',
        '17 + const newName10 = 1;',
        '18 + const newName11 = 1;',
        '… 29 lines hidden (Ctrl+E)',
      ]);
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

    it('shares one compact budget across the files of one call, and still names each file', () => {
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

      // Each file has one hunk, so neither draws a hunk header. The 30 changed lines overflow the
      // 12-row budget. A change-focused cut would keep lines of a.js and of b.js and drop the rows
      // that say which file each is in, so a diff that spans files previews from the top, in
      // order: every row it draws sits under its file's name. The heading counts the files.
      expect(rendered).toContain('● Update(2 files)');
      expect(rendered).toContain('Changed 2 files, added 30 lines');
      expect(rendered).not.toContain('@@');
      expect(rendered.indexOf('+++ a.js')).toBeGreaterThan(-1);
      expect(rendered.indexOf('+++ a.js')).toBeLessThan(rendered.indexOf('+ a.js line 1'));
      expect(rendered).not.toContain('b.js line');
      expect(rendered).toContain('… +20 lines (Ctrl+E)');
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
    expect(rendered.split('\n')).toEqual([
      '● Update(analysis.ipynb)',
      '  ⎿  Added 1 line, removed 1 line',
    ]);
  });

  it('renders a Write(filePath) item when a file is created', () => {
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
    expect(rendered.split('\n')).toEqual(['● Write(src/new-file.txt)', '  ⎿  Wrote 2 lines']);
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
    expect(rendered).not.toContain('…');
    // Assert the content survives the wrap, not where the wrap lands: the
    // break position moves with the result's column budget, the completeness
    // must not. The diff's rows follow the heading and the `Wrote` row, past the
    // result column, the line number and the marker.
    const diffRows = rendered.split('\n').slice(2);
    const diffText = diffRows.map((line) => line.replace(/^ {5}[\d ] [+ ] /, '').trim()).join('');
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
    expect(rendered).toContain('● Update(src/broken.ts)');
    expect(rendered).toContain('⎿  Error: Failed to write file');
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

    expect(frame(outputView.lastFrame)).toContain('● Shell output(shell_1)');
    // A read of a shell is a command's output: its first line is the result.
    expect(frame(outputView.lastFrame)).toContain('⎿  ready');
    expect(frame(killView.lastFrame)).toContain('● Kill shell(shell_1)');
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

  it('renders the heading as exactly one line, its argument cut with … inside the parentheses', () => {
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
    // The heading, then the command's output.
    expect(lines).toHaveLength(2);
    expect(lines[0]!.trimEnd()).toMatch(/^● Bash\(git .*…\)$/);
    expect(displayWidth(lines[0]!.trimEnd())).toBeLessThanOrEqual(width);
    expect(lines[1]!.trim()).toBe('⎿  ok');
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

/**
 * The rows hung under a call's heading, in order: past `⎿  ` on the first and the same five
 * columns on the rest, their trailing spaces dropped. The heading itself is not one of them.
 */
function resultRows(rendered: string): string[] {
  return rendered
    .split('\n')
    .slice(1)
    .map((line) => line.replace(/^ {2}(?:⎿(?: {2}|$)| {3})/, '').trimEnd());
}

describe('ToolCallBlock output rows keep their empty lines (#494)', () => {
  /** What each row of an expanded output block holds, past `⎿`, in order. */
  const outputRows = (
    content: string,
    {
      name = 'Bash',
      args = { command: 'printf out' },
      ...view
    }: {
      name?: string;
      args?: Record<string, unknown>;
      showAllToolOutput?: boolean;
      transcriptMode?: 'compact' | 'detailed';
    } = {},
  ): string[] => {
    const rendered = render(
      withTheme(
        <ToolCallBlock
          name={name}
          args={args}
          result={successResult('call-1', content)}
          isExpanded
          reducedMotion
          {...view}
        />,
      ),
    );
    return resultRows(frame(rendered.lastFrame));
  };

  it('draws the blank line between two paragraphs as an empty row', () => {
    expect(outputRows('S1\n\nS2\n')).toEqual(['S1', '', 'S2']);
  });

  it('draws every empty line of printf "S1\\n\\nS2\\n\\n\\nS3\\n", in Ctrl+E and Ctrl+O alike', () => {
    const output = 'S1\n\nS2\n\n\nS3\n';
    const expected = ['S1', '', 'S2', '', '', 'S3'];
    expect(outputRows(output, { showAllToolOutput: true })).toEqual(expected);
    expect(outputRows(output, { transcriptMode: 'detailed' })).toEqual(expected);
  });

  it('adds no row for the newline that real output ends in', () => {
    expect(outputRows('S1\nS2\n')).toEqual(['S1', 'S2']);
    expect(outputRows('S1\nS2')).toEqual(['S1', 'S2']);
    // Nor does any empty line the output ends in: they are the end of it, not lines of it.
    expect(outputRows('S1\n\n')).toEqual(['S1']);
    expect(outputRows('A\n\nB\n\n\n')).toEqual(['A', '', 'B']);
    // A line of spaces is a line, and so is an empty one with a line after it.
    expect(outputRows('A\n  \n\n')).toEqual(['A', '']);
    expect(outputRows('\nA\n')).toEqual(['', 'A']);
  });

  it('draws no row for an output that is only newlines, such as a bare echo', () => {
    expect(outputRows('\n')).toEqual([]);
    expect(outputRows('\n\n\n')).toEqual([]);
  });

  it('draws one row per line of the output, with no footer for them', () => {
    const header = (content: string) => {
      const rendered = render(
        withTheme(
          <ToolCallBlock
            name="Bash"
            args={{ command: 'printf out' }}
            result={successResult('call-1', content)}
            isExpanded
            reducedMotion
          />,
        ),
      );
      return frame(rendered.lastFrame);
    };
    // A finished row carries no line count of its own: the rows are the output.
    const one = header('X\n');
    expect(one).not.toMatch(/\b1 line\b/);
    expect(one).not.toContain('… +');
    expect(resultRows(one)).toEqual(['X']);

    const three = header('A\n\nB\n\n\n');
    expect(three).not.toMatch(/\b3 lines\b/);
    expect(resultRows(three)).toEqual(['A', '', 'B']);
    expect(three).not.toContain('… +');
  });

  it('previews the last real lines of a failed output that ends in blank lines', () => {
    const stdout = [...Array.from({ length: 12 }, (_, i) => `out ${i + 1}`), 'FAIL x', '', '', ''];
    const result = toolFailure('boom', { content: stdout.join('\n'), details: { exitCode: 1 } });
    const rendered = render(
      withTheme(
        <ToolCallBlock
          name="Bash"
          args={{ command: 'run' }}
          result={{ ...result, status: 'error' }}
          isExpanded
          transcriptMode="detailed"
          reducedMotion
        />,
      ),
    );
    const rows = resultRows(frame(rendered.lastFrame));
    // The exit code and the message open the result; the stdout block follows them.
    expect(rows[0]).toBe('Error: exit 1');
    // 13 lines under a 10-line tail preview: the last nine and `FAIL x`, then the footer.
    const block = rows.slice(-11);
    expect(block.at(-1)).toMatch(/^… \+3 lines/);
    expect(block.at(-2)).toBe('FAIL x');
    expect(block[0]).toBe('out 4');
    expect(block).not.toContain('');
  });

  it('keeps the empty lines of a highlighted output too', () => {
    // A Read of a source file is highlighted: its own branch draws the rows, under the row
    // that says what it read.
    const rows = outputRows('a.ts\n\nconst x = 1;\n', { name: 'Read', args: { filePath: 'a.ts' } });
    expect(rows[0]).toMatch(/^Read \d+ lines?$/);
    expect(rows.slice(1)).toEqual(['a.ts', '', 'const x = 1;']);
  });

  it('draws as many rows as the footer of a cut output counts lines', () => {
    const output = Array.from({ length: 10 }, (_, i) => `l${i}\n`).join('\n');
    const rendered = render(
      withTheme(
        <ToolCallBlock
          name="Bash"
          args={{ command: 'seq 10' }}
          result={successResult('call-1', output)}
          isExpanded
          reducedMotion
        />,
      ),
    );
    const text = frame(rendered.lastFrame);
    // 10 lines and the 9 empty ones between them are 19 rows, and the newline after the last is
    // none: a preview of 6 of them leaves 13 out.
    const shown = resultRows(text).filter((line) => !line.includes('…')).length;
    expect(shown).toBe(6);
    expect(text).toContain('… +13 lines');
  });
});

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

    expect(lines[0]).toBe('● Bash(npm test)');
    expect(lines[0]).not.toContain('Invalid arguments');
    // The message hangs under the heading and opens on what kind of stop it was.
    expect(resultRows(lines.join('\n')).join(' ')).toBe(`Error: ${MESSAGE}`);
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

      expect(firstLine(inMemory(row))).toBe('● Update(memory/notes.md)');
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

      expect(firstLine(inMemory(row))).toBe('● Read(memory/notes.md)');
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

    expect(raw).toContain(`${rgb(DEFAULT_THEME.inactive)}●`);
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

    expect(raw).toContain(`${rgb(DEFAULT_THEME.error)}●`);
    expect(raw).toContain(`${rgb(DEFAULT_THEME.error)}Error: Exit code: 1`);
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

    // The heading carries no duration; the exit code opens the result.
    expect(lines[0]).toBe('● Bash(bash scripts/fail.sh)');
    expect(rendered).not.toContain('7ms');
    expect(resultRows(lines.join('\n'))).toEqual([
      'Error: exit 1',
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

    expect(lines[0]).toBe('● Bash(bash scripts/fail.sh)');
    expect(resultRows(lines.join('\n'))).toEqual(['Error: exit 1', ...stderr]);
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
    const lines = resultRows(rendered).filter(Boolean);

    expect(lines).toEqual(['Error: exit 1', '… +36 lines (Ctrl+E)', ...stderr.slice(-4)]);
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
    const [exit, ...detail] = resultRows(rendered).filter(Boolean);

    expect(exit).toBe('Error: exit 1');
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

    expect(lines[0]).toBe('● Bash(npm test)');
    expect(resultRows(lines.join('\n'))).toEqual([
      'Error: exit 1',
      '… +8 lines (Ctrl+E)',
      'FAIL test/case_9.test.js',
      'FAIL test/case_10.test.js',
      'FAIL test/case_11.test.js',
      'FAIL test/case_12.test.js',
    ]);
    expect(lines.slice(1).join('\n')).not.toContain('Exit code: 1');
    expect(rendered).not.toContain('7ms');
    expect(raw).toContain(`${rgb(DEFAULT_THEME.error)}FAIL test/case_12`);
  });

  describe('a failed command with stdout under its stderr', () => {
    const STDERR = 'npm warn config something';
    const STDOUT = 'FAIL test/a.test.js > expected 1, got 2';
    const failed = (name = 'Bash', args: Record<string, unknown> = { command: 'npm test' }) =>
      enrichToolResultPresentation(
        {
          ...toolFailure(STDERR, { content: STDOUT, details: { exitCode: 1 } }),
          metrics: { durationMs: 7 },
        },
        name,
        args,
      );
    const draw = (
      result: ToolResult,
      view: {
        targetId?: string;
        name?: string;
        args?: Record<string, unknown>;
        isExpanded?: boolean;
        showAllToolOutput?: boolean;
        transcriptMode?: 'compact' | 'detailed';
      } = {},
    ) =>
      colourFrame(
        asTarget(
          view.targetId ?? 'fail-1',
          <ToolCallBlock
            toolId="fail-1"
            name={view.name ?? 'Bash'}
            args={view.args ?? { command: 'npm test' }}
            result={result}
            isExpanded={view.isExpanded ?? false}
            showAllToolOutput={view.showAllToolOutput ?? false}
            transcriptMode={view.transcriptMode ?? 'compact'}
            terminalWidth={100}
            reducedMotion
          />,
        ),
      );
    /** The rows of the frame, trimmed, the result's `⎿` connector dropped from its first. */
    const linesOf = (raw: string) =>
      stripAnsi(raw)
        .split('\n')
        .filter((line) => line.trim().length > 0)
        .map((line) => line.trim().replace(/^⎿\s+/, ''));

    it('names the stdout under the stderr tail, and the key on the Ctrl+E target', () => {
      const raw = draw(failed());
      const lines = linesOf(raw);

      expect(lines[0]).toBe('● Bash(npm test)');
      expect(lines.slice(1)).toEqual(['Error: exit 1', STDERR, '… +1 line of output (Ctrl+E)']);
      expect(raw).toContain(`${rgb(DEFAULT_THEME.error)}${STDERR}`);
      expect(raw).toContain(`${rgb(DEFAULT_THEME.inactive)}… +1 line of output (Ctrl+E)`);
      expect(stripAnsi(raw)).not.toContain(STDOUT);
    });

    it('drops the key from the footer of a row that Ctrl+E does not target', () => {
      const lines = linesOf(draw(failed(), { targetId: 'some-other-row' }));
      expect(lines.slice(1)).toEqual(['Error: exit 1', STDERR, '… +1 line of output']);
    });

    it('does the same for a failed Check row', () => {
      const view = { name: 'Check', args: { name: 'unit' } };
      const lines = linesOf(draw(failed('Check', { name: 'unit' }), view));
      expect(lines[0]).toBe('● Check(unit)');
      expect(lines.slice(1)).toEqual(['Error: exit 1', STDERR, '… +1 line of output (Ctrl+E)']);
    });

    it('draws the stdout once, with no footer, when Ctrl+E has shown the row in full', () => {
      const rendered = stripAnsi(draw(failed(), { isExpanded: true, showAllToolOutput: true }));
      expect(rendered.split(STDERR)).toHaveLength(2);
      expect(rendered.split(STDOUT)).toHaveLength(2);
      expect(rendered).not.toContain('of output');
      expect(rendered).not.toContain('… +');
    });

    it('draws the stdout once in a row that is open but not shown in full', () => {
      // Clicked open, or in the detailed transcript (Ctrl+O): the output block draws the stdout.
      for (const view of [
        { isExpanded: true },
        { isExpanded: true, transcriptMode: 'detailed' as const },
      ]) {
        const rendered = stripAnsi(draw(failed(), view));
        expect(rendered.split(STDERR)).toHaveLength(2);
        expect(rendered.split(STDOUT)).toHaveLength(2);
        expect(rendered).not.toContain('of output');
      }
    });

    it('reads after the sandbox note, as the last row of the detail', () => {
      const note = 'Note: run it outside the sandbox.';
      const result = toolFailure(`${STDERR}\n${note}`, {
        content: STDOUT,
        details: { exitCode: 128 },
      });
      expect(linesOf(draw(result)).slice(1)).toEqual([
        'Error: exit 128',
        STDERR,
        note,
        '… +1 line of output (Ctrl+E)',
      ]);
    });

    describe('when stderr cuts lines of its own', () => {
      const stderr = Array.from({ length: 12 }, (_, i) => `error: line ${i + 1}`);
      const cut = toolFailure(stderr.join('\n'), {
        content: STDOUT,
        details: { exitCode: 1 },
      });

      it('carries both counts in the one footer above the tail, with the key once', () => {
        const raw = draw(cut);
        expect(linesOf(raw).slice(1)).toEqual([
          'Error: exit 1',
          '… +8 lines, +1 line of output (Ctrl+E)',
          ...stderr.slice(-4),
        ]);
        expect(raw).toContain(
          `${rgb(DEFAULT_THEME.inactive)}… +8 lines, +1 line of output (Ctrl+E)`,
        );
        expect(stripAnsi(raw)).not.toContain(STDOUT);
      });

      it('drops the key from it on a row that Ctrl+E does not target', () => {
        const lines = linesOf(draw(cut, { targetId: 'some-other-row' })).slice(1);
        expect(lines).toEqual([
          'Error: exit 1',
          '… +8 lines, +1 line of output',
          ...stderr.slice(-4),
        ]);
      });

      it('names no stdout when the row is open: the output block draws it', () => {
        const rendered = stripAnsi(draw(cut, { isExpanded: true, showAllToolOutput: true }));
        expect(rendered.split(STDOUT)).toHaveLength(2);
        expect(rendered).not.toContain('of output');
      });

      it('counts a stdout that ends in a newline as the one row its block draws', () => {
        const tail = toolFailure(stderr.join('\n'), {
          content: 'OUT-A\n',
          details: { exitCode: 1 },
        });
        expect(linesOf(draw(tail)).slice(1)[1]).toBe('… +8 lines, +1 line of output (Ctrl+E)');
        const open = stripAnsi(draw(tail, { isExpanded: true, showAllToolOutput: true }));
        // The exit code and the whole stderr, then the output block's one row.
        expect(resultRows(open).slice(1 + stderr.length)).toEqual(['OUT-A']);
      });
    });

    describe('names as many lines of output as the block then draws rows', () => {
      /** The count in the footer, and the rows of the output block once Ctrl+E has shown the row. */
      const namedAndDrawn = (stdout: string) => {
        const result = toolFailure(STDERR, { content: stdout, details: { exitCode: 1 } });
        const footer = /\+(\d+) lines? of output/.exec(stripAnsi(draw(result)));
        const open = stripAnsi(draw(result, { isExpanded: true, showAllToolOutput: true }));
        // The output block's rows follow the exit code and the one stderr row.
        const rows = resultRows(open).slice(2).length;
        return { named: Number(footer?.[1]), rows };
      };

      it('takes a row for an empty line in the text, and none for the newline after it', () => {
        // The block splits this into six lines and draws five: the empty line after the final
        // newline is the one that takes no row.
        expect(namedAndDrawn('A\n\nB\n   \nC\n')).toEqual({ named: 5, rows: 5 });
      });

      it('reads one line for the one line a command prints, with its newline or without', () => {
        for (const stdout of ['BASH-OUT-LINE\n', 'BASH-OUT-LINE', 'BASH-OUT-LINE\r\n']) {
          expect([stdout, namedAndDrawn(stdout)]).toEqual([stdout, { named: 1, rows: 1 }]);
        }
      });

      it('leaves the \\r of a CRLF on its line, as the block does: a line of only a \\r is a row', () => {
        expect(namedAndDrawn('A\r\n\r\nB\r\n')).toEqual({ named: 3, rows: 3 });
        expect(namedAndDrawn('one\r\ntwo\r\n')).toEqual({ named: 2, rows: 2 });
      });

      it('counts the empty lines before and inside the text, which the block draws as rows', () => {
        expect(namedAndDrawn('\n\nFAIL a\n \n\nexpected 1\n\n')).toEqual({ named: 6, rows: 6 });
      });
    });

    it('names no stdout that is only control characters', () => {
      const result = toolFailure(STDERR, { content: '\u200e\n\u001b\n', details: { exitCode: 1 } });
      expect(linesOf(draw(result)).slice(1)).toEqual(['Error: exit 1', STDERR]);
    });

    it('names the stdout again once the row is folded back', () => {
      const lines = linesOf(draw(failed(), { isExpanded: false, showAllToolOutput: true }));
      expect(lines.slice(1)).toEqual(['Error: exit 1', STDERR, '… +1 line of output (Ctrl+E)']);
    });
  });

  it('shows only its exit code for a command that failed with no output at all', () => {
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
    expect(lines).toEqual(['● Bash(false)', '  ⎿  Error: exit 3']);
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
    expect(resultRows(stripAnsi(raw)).filter(Boolean)).toEqual([
      'Error: exit 128',
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

  it('names the step in hand and says where the plan stands, with no check', () => {
    // `✓ Steps  Clone vibe-coding repo into workspace   0 of 3 done` read as a step done.
    const rendered = planFrame(['in_progress', 'pending', 'pending']);
    expect(rendered.split('\n')).toEqual(['● Steps(Step 1)', '  ⎿  0 of 3 done']);
    expect(rendered).not.toContain('✓');
  });

  it('says a plan set out and not begun', () => {
    expect(planFrame(['pending', 'pending']).split('\n')).toEqual(['● Steps', '  ⎿  0 of 2 done']);
  });

  it('says a finished plan is done', () => {
    expect(planFrame(['completed', 'completed'])).toContain('⎿  2 of 2 done');
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
    ['a diff', 'write-new', '… +145 lines'],
    ['a capped edit', 'edit-long', '… 189 lines hidden'],
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
    ['a diff', 'write-new', '… +145 lines (Ctrl+E)'],
    ['a capped edit', 'edit-long', '… 189 lines hidden (Ctrl+E)'],
    ['a failed command', 'bash-fail', '… +36 lines (Ctrl+E)'],
  ])('names the key in %s footer when the row is the target', (_name, id, footer) => {
    expect(renderRow(id, { target: id })).toContain(footer);
  });

  it('names no key in the compact transcript outside a provider', () => {
    // With no provider nothing says Ctrl+E acts on this row, so it must not claim the key.
    const rendered = renderRow('write-new');
    expect(rendered).toContain('… +145 lines');
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
    // A failed command with stdout as well as stderr (#480): the footer names that stdout.
    const failedWith = (
      id: string,
      stdout: string,
      expanded: boolean,
      name = 'Bash',
      args: Record<string, unknown> = { command: 'npm test' },
      stderr = 'npm warn config something',
    ) => ({
      call: { id, name, arguments: args },
      result: enrichToolResultPresentation(
        {
          ...toolFailure(stderr, {
            content: stdout,
            details: { exitCode: 1 },
          }),
          toolCallId: id,
        },
        name,
        args,
      ),
      expanded,
    });
    const cutStderr = Array.from({ length: 12 }, (_, i) => `error: line ${i + 1}`).join('\n');
    const failures = [
      failedWith('stdout-collapsed', 'FAIL a', false),
      failedWith('stdout-many', output, false),
      failedWith('stdout-open', 'FAIL a', true),
      failedWith('stdout-open-long', output, true),
      failedWith('stdout-blank', '\n  \n', false),
      failedWith('stdout-controls', '\u200e\n\u001b\n', false),
      failedWith('stdout-none', '', false),
      failedWith('check-collapsed', 'FAIL a', false, 'Check', { name: 'unit' }),
      // A stderr that cuts lines of its own: its footer is the row's one, and counts the stdout too.
      failedWith('cut-and-stdout', 'FAIL a', false, 'Bash', { command: 'npm test' }, cutStderr),
      failedWith('cut-and-open', 'FAIL a', true, 'Bash', { command: 'npm test' }, cutStderr),
      failedWith('cut-and-blank', '\n \n', false, 'Bash', { command: 'npm test' }, cutStderr),
      failedWith('cut-and-controls', '\u200e\n', false, 'Bash', { command: 'npm test' }, cutStderr),
      failedWith('cut-only', '', false, 'Bash', { command: 'npm test' }, cutStderr),
    ];
    // The rows whose stdout the footer names: collapsed, with a non-blank stdout. An open row's
    // output block draws that stdout itself, so naming it as well would draw it twice.
    const namesStdout = new Set([
      'stdout-collapsed',
      'stdout-many',
      'check-collapsed',
      'cut-and-stdout',
    ]);
    const cases = [
      ...rows.map((row) => ({
        call: row.call,
        result: row.result,
        expanded: shouldDefaultExpandTool(row.call.name, row.result),
      })),
      ...extra,
      ...failures,
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
      // A footer is `… +N lines` under a head preview and `… N lines hidden` under a change one.
      const footer = /… (?:\+\d|\d+ lines? hidden)/.test(rendered);
      expect([call.id, footer]).toEqual([call.id, hides]);
      expect([call.id, rendered.includes('of output')]).toEqual([
        call.id,
        namesStdout.has(call.id),
      ]);
    }
  });
});
