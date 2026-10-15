import chalk from 'chalk';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from 'ink-testing-library';
import { Box } from 'ink';
import { act } from 'react';
import { ThemeContext, DEFAULT_THEME } from '../theme.js';
import { ToolCallBlock } from './ToolCallBlock.js';
import { displayWidth } from './word-wrap.js';
import type { FileMutationSummary, ToolResult } from '../../types/tools.js';
import { enrichToolResultPresentation, toolFailure, toolSuccess } from '../../tools/result.js';

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
        <ToolCallBlock
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

    it('caps an Edit diff longer than 80 rows', () => {
      const output = [
        '@@ -1,100 +1,100 @@',
        ...Array.from({ length: 100 }, (_, index) => `-old ${index + 1}`),
        ...Array.from({ length: 100 }, (_, index) => `+new ${index + 1}`),
      ].join('\n');
      const view = render(
        withTheme(
          <ToolCallBlock
            name="Edit"
            args={{ filePath: 'src/a.ts' }}
            result={successResult('call-edit-long', output, {
              kind: 'update',
              filePath: 'src/a.ts',
              addedLines: 100,
              removedLines: 100,
            })}
            isExpanded
            reducedMotion
          />,
        ),
      );
      const rendered = frame(view.lastFrame);

      expect(rendered).toContain('- old 39');
      expect(rendered).not.toContain('- old 40');
      expect(rendered).toContain('+ new 100');
      expect(rendered).not.toContain('+ new 50');
      expect(rendered).toContain('… 121 lines hidden (Ctrl+E)');
      expect(rendered).toContain('⋮ 121 lines omitted');
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
          <ToolCallBlock name="ApplyPatch" args={{}} result={result} isExpanded reducedMotion />,
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
      <ToolCallBlock
        name="Bash"
        args={{ command: 'bash scripts/fail.sh' }}
        result={result}
        isExpanded={false}
        terminalWidth={100}
        reducedMotion
      />,
    );
    const rendered = stripAnsi(raw);
    const lines = rendered.split('\n').filter((line) => line.trim().length > 0);

    expect(lines[0]).toMatch(/failed · exit 1 · 7ms/);
    expect(lines.slice(1).map((line) => line.trim())).toEqual([
      '… +36 lines',
      'error: assertion 37 failed in test/case_37.test.js: expected 200, got 500',
      'error: assertion 38 failed in test/case_38.test.js: expected 200, got 500',
      'error: assertion 39 failed in test/case_39.test.js: expected 200, got 500',
      'error: assertion 40 failed in test/case_40.test.js: expected 200, got 500',
    ]);
    expect(rendered).not.toContain('assertion 1 failed');
    expect(raw).toContain(`${rgb(DEFAULT_THEME.inactive)}… +36 lines`);
    expect(raw).toContain(`${rgb(DEFAULT_THEME.error)}error: assertion 40`);
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
      <ToolCallBlock
        name="Bash"
        args={{ command: 'npm test' }}
        result={result}
        isExpanded={false}
        terminalWidth={100}
        reducedMotion
      />,
    );
    const rendered = stripAnsi(raw);
    const lines = rendered.split('\n').filter((line) => line.trim().length > 0);

    expect(lines[0]).toMatch(/failed · exit 1 · 7ms/);
    expect(lines[0]).not.toMatch(/12 lines/);
    expect(lines.slice(1).map((line) => line.trim())).toEqual([
      '… +8 lines',
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
