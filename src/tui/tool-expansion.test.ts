import { beforeEach, describe, expect, it, vi } from 'vitest';
import { assistantMsg } from '../test/fixtures.js';
import { workloadMessages, workloadRows } from '../test/tool-expand-workload.js';
import { enrichToolResultPresentation, toolFailure } from '../tools/result.js';
import { shellTools } from '../tools/shell.js';
import type { Message } from '../types/messages.js';
import type { ResolvedShell } from '../types/runtime.js';
import type { ToolCall, ToolResult } from '../types/tools.js';
import { getCompletedTimelineWindow } from './components/ChatPanel.js';
import { indentedGrid, transcriptGrid } from './layout.js';
import {
  selectExpandTargetId,
  toolRowHidesContent,
  type ExpandTargetInput,
} from './tool-expansion.js';
import {
  composeResultErrorDetail,
  deriveToolPresentation,
  mutationDiffPreviewInput,
} from './tool-presentation.js';

// Counts the diff parser's callers: the walk must not re-parse a row whose result did not change.
const diffParser = vi.hoisted(() => ({ calls: 0 }));
vi.mock('./components/Diff.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./components/Diff.js')>();
  return {
    ...actual,
    diffPreviewOmittedRows: (...args: Parameters<typeof actual.diffPreviewOmittedRows>) => {
      diffParser.calls++;
      return actual.diffPreviewOmittedRows(...args);
    },
  };
});

const WIDTH = 100;
const HEIGHT = 40;

function target(overrides: Partial<ExpandTargetInput> = {}): string | null {
  return selectExpandTargetId({
    messages: workloadMessages(),
    transcriptMode: 'compact',
    terminalWidth: WIDTH,
    terminalHeight: HEIGHT,
    expansionOverrides: new Map(),
    showAllToolOutputIds: new Set(),
    focusedToolId: null,
    automaticToolId: null,
    running: true,
    ...overrides,
  });
}

/** What Ctrl+E records for a row: an override and a place in the show-all set. */
function showIn(
  ...ids: string[]
): Pick<ExpandTargetInput, 'expansionOverrides' | 'showAllToolOutputIds'> {
  return {
    expansionOverrides: new Map(ids.map((id) => [id, true])),
    showAllToolOutputIds: new Set(ids),
  };
}

describe('selectExpandTargetId', () => {
  it('targets the newest truncated row, passing a Read whose body is not drawn', () => {
    expect(target()).toBe('edit-long');
  });

  it('moves up one truncated row per press as each is shown in full', () => {
    expect(target(showIn('edit-long'))).toBe('write-new');
    expect(target(showIn('edit-long', 'write-new'))).toBe('bash-fail');
  });

  it('falls back to the latest tool once every truncated row is shown in full', () => {
    expect(target(showIn('edit-long', 'write-new', 'bash-fail'))).toBe('edit-long');
  });

  it('skips a row in the show-all set even when it is not expanded', () => {
    expect(target({ showAllToolOutputIds: new Set(['edit-long', 'write-new', 'bash-fail']) })).toBe(
      'edit-long',
    );
  });

  it('lets an active running tool win while a turn is in progress', () => {
    expect(target({ automaticToolId: 'read-1' })).toBe('read-1');
  });

  it('ignores an unresolved call when no turn is running', () => {
    // An aborted turn leaves a call without a result behind; it must not hold the target.
    expect(target({ automaticToolId: 'read-1', running: false })).toBe('edit-long');
    expect(target({ automaticToolId: 'read-1', running: false, transcriptMode: 'detailed' })).toBe(
      'edit-long',
    );
  });

  it('lets a focused row win while it hides content', () => {
    expect(target({ focusedToolId: 'write-new' })).toBe('write-new');
    expect(target({ focusedToolId: 'bash-fail' })).toBe('bash-fail');
  });

  it('skips a focused row that hides nothing: not truncated, shown in full, or folded', () => {
    expect(target({ focusedToolId: 'read-1' })).toBe('edit-long');
    expect(target({ focusedToolId: 'write-new', ...showIn('write-new') })).toBe('edit-long');
    // A click folded the default-expanded diff: its body is not drawn, so no footer is.
    expect(
      target({ focusedToolId: 'write-new', expansionOverrides: new Map([['write-new', false]]) }),
    ).toBe('edit-long');
  });

  it('does not target an unknown focused row', () => {
    expect(target({ focusedToolId: 'gone' })).toBe('edit-long');
  });

  it('lets a focused nested invocation win while it hides content', () => {
    const rows = workloadRows();
    const message: Message = {
      ...workloadMessages(rows.slice(0, 2))[0]!,
      nestedToolInvocations: [
        {
          traceId: 'nested-1',
          parentTraceId: 'bash-fail',
          call: { id: 'n1', name: 'Write', arguments: { filePath: 'src/new.ts' } },
          result: rows[2]!.result,
        },
      ],
    };
    expect(target({ messages: [message], focusedToolId: 'nested-1' })).toBe('nested-1');
    expect(
      target({
        messages: [message],
        focusedToolId: 'nested-1',
        expansionOverrides: new Map([['nested-1', false]]),
      }),
    ).toBe('bash-fail');
  });

  it('does not count a row that is not truncated', () => {
    const rows = workloadRows().filter((row) => row.call.id === 'read-1');
    expect(target({ messages: workloadMessages(rows) })).toBe('read-1');
  });

  it('counts a successful command only once its output is drawn and cut', () => {
    const output = Array.from({ length: 30 }, (_, i) => `row ${i}`).join('\n');
    const messages = [
      assistantMsg(
        '',
        [{ id: 'bash-ok', name: 'Bash', arguments: { command: 'seq 30' } }],
        [{ version: 2, toolCallId: 'bash-ok', status: 'success', content: output }],
      ),
    ];
    expect(target({ messages })).toBe('bash-ok'); // the latest: nothing is drawn
    const older = workloadMessages();
    expect(target({ messages: [...older, ...messages] })).toBe('edit-long');
    expect(
      target({
        messages: [...older, ...messages],
        expansionOverrides: new Map([['bash-ok', true]]),
      }),
    ).toBe('bash-ok');
  });

  it('walks messages from the newest and looks no further than the first match', () => {
    const older = workloadMessages();
    const newer: Message[] = [
      assistantMsg('no tools'),
      {
        ...assistantMsg('', [workloadRows()[1]!.call], [workloadRows()[1]!.result]),
        id: 'a2',
      },
    ];
    expect(target({ messages: [...older, ...newer] })).toBe('bash-fail');
  });

  it('never picks a nested subagent invocation', () => {
    const rows = workloadRows();
    const message: Message = {
      ...workloadMessages(rows.slice(0, 2))[0]!,
      nestedToolInvocations: [
        {
          traceId: 'nested-1',
          parentTraceId: 'bash-fail',
          call: { id: 'n1', name: 'Bash', arguments: { command: 'x' } },
          result: rows[1]!.result,
        },
      ],
    };
    expect(target({ messages: [message] })).toBe('bash-fail');
  });

  it('keeps the old order in the detailed transcript: focused, else the latest', () => {
    expect(target({ transcriptMode: 'detailed' })).toBe('edit-long');
    expect(target({ transcriptMode: 'detailed', focusedToolId: 'read-1' })).toBe('read-1');
    expect(target({ transcriptMode: 'detailed', automaticToolId: 'write-new' })).toBe('write-new');
  });

  it('is null for a transcript with no tools', () => {
    expect(target({ messages: [assistantMsg('hello')] })).toBeNull();
  });

  describe('the rows on screen', () => {
    // ChatPanel draws the newest getCompletedTimelineWindow(height) entries: 80 at height 8.
    const SMALL_HEIGHT = 8;
    const prose = (count: number): Message[] =>
      Array.from({ length: count }, (_, index) => ({
        ...assistantMsg(`prose ${index}`),
        id: `prose-${index}`,
      }));
    const oldWrite = workloadMessages(workloadRows().filter((row) => row.call.id === 'write-new'));
    const newRead = workloadMessages(workloadRows().filter((row) => row.call.id === 'read-1'));

    it('never targets a truncated row that has scrolled out of the rendered window', () => {
      const messages = [...oldWrite, ...prose(100), ...newRead];
      expect(getCompletedTimelineWindow(SMALL_HEIGHT)).toBe(80);
      // The 150-line Write is message 0 of 102: not drawn, so no footer would show the key.
      expect(target({ messages, terminalHeight: SMALL_HEIGHT })).toBe('read-1');
    });

    it('still targets that row while it is inside the window', () => {
      const messages = [...oldWrite, ...prose(50), ...newRead];
      expect(target({ messages, terminalHeight: SMALL_HEIGHT })).toBe('write-new');
    });

    it('widens the window with the terminal height', () => {
      const messages = [...oldWrite, ...prose(100), ...newRead];
      expect(getCompletedTimelineWindow(40)).toBeGreaterThan(102);
      expect(target({ messages, terminalHeight: 40 })).toBe('write-new');
    });

    it('does not let a focused row outside the window win either', () => {
      const messages = [...oldWrite, ...prose(100), ...newRead];
      expect(target({ messages, terminalHeight: SMALL_HEIGHT, focusedToolId: 'write-new' })).toBe(
        'read-1',
      );
    });
  });

  describe('caching', () => {
    beforeEach(() => {
      diffParser.calls = 0;
    });

    it('does not parse a row again when the same results come back', () => {
      const messages = workloadMessages();
      expect(target({ messages })).toBe('edit-long');
      const parsed = diffParser.calls;
      expect(parsed).toBeGreaterThan(0);
      // A streamed batch gives the messages a new identity; the results keep theirs.
      const next = messages.map((message) => ({ ...message }));
      expect(target({ messages: next })).toBe('edit-long');
      expect(target({ messages: next, focusedToolId: 'edit-long' })).toBe('edit-long');
      expect(diffParser.calls).toBe(parsed);
    });

    it('parses again for an input that changes the answer, and for a replaced result', () => {
      const messages = workloadMessages();
      target({ messages });
      const parsed = diffParser.calls;
      target({ messages, terminalWidth: WIDTH - 20 });
      expect(diffParser.calls).toBeGreaterThan(parsed);

      const afterWidth = diffParser.calls;
      const [message] = messages;
      const replaced: Message = {
        ...message!,
        toolResults: message!.toolResults!.map((result) => ({ ...result })),
      };
      target({ messages: [replaced], terminalWidth: WIDTH - 20 });
      expect(diffParser.calls).toBeGreaterThan(afterWidth);
    });

    it('keeps the answer right when a row is expanded or shown in full', () => {
      const messages = workloadMessages();
      expect(target({ messages })).toBe('edit-long');
      expect(target({ messages, ...showIn('edit-long') })).toBe('write-new');
      expect(target({ messages })).toBe('edit-long');
    });
  });
});

describe('toolRowHidesContent', () => {
  it('reports each row of the workload as the compact transcript draws it', () => {
    for (const row of workloadRows()) {
      expect(
        toolRowHidesContent({
          name: row.call.name,
          args: row.call.arguments,
          result: row.result,
          isExpanded: row.call.id !== 'read-1' && row.call.id !== 'bash-fail',
          transcriptMode: 'compact',
          terminalWidth: WIDTH,
          showAllToolOutput: false,
        }),
      ).toBe(row.truncated);
    }
  });

  it('says a row shown in full hides nothing', () => {
    for (const row of workloadRows()) {
      expect(
        toolRowHidesContent({
          name: row.call.name,
          args: row.call.arguments,
          result: row.result,
          isExpanded: true,
          transcriptMode: 'compact',
          terminalWidth: WIDTH,
          showAllToolOutput: true,
        }),
      ).toBe(false);
    }
  });

  it('says a screen reader row hides nothing', () => {
    const row = workloadRows()[3]!;
    expect(
      toolRowHidesContent({
        name: row.call.name,
        args: row.call.arguments,
        result: row.result,
        isExpanded: true,
        transcriptMode: 'compact',
        screenReader: true,
        terminalWidth: WIDTH,
        showAllToolOutput: false,
      }),
    ).toBe(false);
  });
});

describe('a failed command whose stdout its row leaves out', () => {
  const STDERR = 'npm warn config something';
  const STDOUT = 'FAIL test/a.test.js > expected 1, got 2';

  interface Row {
    call: ToolCall;
    result: ToolResult;
  }

  /** The way Bash and Check both report a failure: stderr is the message, stdout the content. */
  function failedCommand(
    name: string,
    args: Record<string, unknown>,
    stdout = STDOUT,
    stderr = STDERR,
  ): Row {
    const id = `${name}-failed`;
    const result = enrichToolResultPresentation(
      { ...toolFailure(stderr, { content: stdout, details: { exitCode: 1 } }), toolCallId: id },
      name,
      args,
    );
    return { call: { id, name, arguments: args }, result };
  }

  /** A newer row that hides nothing: a command that succeeded draws no body while it is collapsed. */
  function newerOk(): Row {
    return {
      call: { id: 'newer-ok', name: 'Bash', arguments: { command: 'echo newer-ok' } },
      result: { version: 2, toolCallId: 'newer-ok', status: 'success', content: 'newer-ok' },
    };
  }

  const turn = (...rows: Row[]): Message => ({
    ...assistantMsg(
      '',
      rows.map((row) => row.call),
      rows.map((row) => row.result),
    ),
    id: 'turn-failed',
  });

  function hides(row: Row, view: { isExpanded?: boolean; showAllToolOutput?: boolean } = {}) {
    return toolRowHidesContent({
      name: row.call.name,
      args: row.call.arguments,
      result: row.result,
      isExpanded: view.isExpanded ?? false,
      transcriptMode: 'compact',
      terminalWidth: WIDTH,
      showAllToolOutput: view.showAllToolOutput ?? false,
    });
  }

  describe.each([
    ['Bash', { command: 'npm test' }],
    ['Check', { name: 'unit' }],
  ])('a failed %s row', (name, args) => {
    const failed = failedCommand(name, args);

    it('hides its stdout while it is collapsed, and nothing once it is shown in full', () => {
      expect(hides(failed)).toBe(true);
      expect(hides(failed, { isExpanded: true, showAllToolOutput: true })).toBe(false);
    });

    it('hides nothing while it is expanded and its output block draws the whole stdout', () => {
      expect(hides(failed, { isExpanded: true })).toBe(false);
    });

    it('is the Ctrl+E target although a newer row hides nothing', () => {
      expect(target({ messages: [turn(failed, newerOk())] })).toBe(failed.call.id);
    });

    it('is not the target without a stdout: the stdout is what the row hides', () => {
      const stderrOnly = failedCommand(name, args, '');
      expect(hides(stderrOnly)).toBe(false);
      expect(target({ messages: [turn(stderrOnly, newerOk())] })).toBe('newer-ok');
    });

    it('still hides content when its stderr cuts lines of its own: that hint is the one footer', () => {
      const stderr = Array.from({ length: 12 }, (_, i) => `error: line ${i + 1}`).join('\n');
      const long = failedCommand(name, args, STDOUT, stderr);
      expect(hides(long)).toBe(true);
      expect(target({ messages: [turn(long, newerOk())] })).toBe(long.call.id);
      expect(hides(long, { isExpanded: true, showAllToolOutput: true })).toBe(false);
    });

    it('hands the target to the next truncated row once expanded and shown in full', () => {
      const messages = [...workloadMessages(), turn(failed, newerOk())];
      expect(target({ messages })).toBe(failed.call.id);
      expect(target({ messages, ...showIn(failed.call.id) })).toBe('edit-long');
    });

    it('wins as the focused row while it hides its stdout, and not once it is shown', () => {
      const messages = [...workloadMessages(), turn(failed, newerOk())];
      expect(target({ messages, focusedToolId: failed.call.id })).toBe(failed.call.id);
      expect(target({ messages, focusedToolId: failed.call.id, ...showIn(failed.call.id) })).toBe(
        'edit-long',
      );
    });
  });

  describe('BashOutput', () => {
    const shellRead = (): Row => {
      const output = Array.from({ length: 30 }, (_, i) => `row ${i}`).join('\n');
      return {
        call: { id: 'shell-read', name: 'BashOutput', arguments: { shell_id: 'shell-1' } },
        result: {
          version: 2,
          toolCallId: 'shell-read',
          status: 'success',
          content: output,
          data: { shell: { id: 'shell-1', status: 'failed', exitCode: 2 }, output, remaining: 0 },
        },
      };
    };

    it('hides nothing in a read of a failed shell while collapsed: the read succeeded', () => {
      // The shell's one buffer holds both streams and no stderr is set under the row, so this is a
      // success row like any other: it draws no body collapsed, and no footer to name a key on.
      const read = shellRead();
      expect(hides(read)).toBe(false);
      expect(target({ messages: [...workloadMessages(), turn(read)] })).toBe('edit-long');
      // Expanded, its output is drawn and cut like any command's.
      expect(hides(read, { isExpanded: true })).toBe(true);
    });

    it('is read by the exit code a failure records, not by the tool name', () => {
      const failed = failedCommand('BashOutput', { shell_id: 'shell-1' });
      expect(hides(failed)).toBe(true);
      expect(target({ messages: [turn(failed, newerOk())] })).toBe(failed.call.id);
    });
  });

  describe('a command whose stderr was only whitespace', () => {
    // `echo >&2` writes one newline. The shell tool used to report that newline as the message,
    // which a row skips as blank: it drew no stdout, and Ctrl+E passed over it. It now reports
    // `Exit code: N`, so the row is any other command that said nothing on stderr.
    const bash = shellTools.find((tool) => tool.name === 'Bash')!;
    const shell: ResolvedShell =
      process.platform === 'win32'
        ? { kind: 'cmd', label: 'cmd.exe', source: 'fallback' }
        : { kind: 'sh', label: '/bin/sh', source: 'detected' };

    /** What the real Bash tool returns for a command that prints `lines` lines, then a bare newline to stderr. */
    async function silentFailure(lines: number): Promise<Row> {
      const script = `for (let i = 1; i <= ${lines}; i++) console.log('FAIL-LINE ' + i); process.stderr.write('\\n'); process.exitCode = 1`;
      const command = `node -e "${script}"`;
      const id = 'whitespace-stderr';
      const result = await bash.execute(
        { command },
        { workspaceRoot: process.cwd(), env: {}, shell },
      );
      return {
        call: { id, name: 'Bash', arguments: { command } },
        result: enrichToolResultPresentation({ ...result, toolCallId: id }, 'Bash', { command }),
      };
    }

    it('shows its stdout as the detail, as any command that said nothing on stderr does', async () => {
      const row = await silentFailure(12);
      expect(row.result.structuredError?.message).toBe('Exit code: 1');
      const detail = composeResultErrorDetail({
        presentation: deriveToolPresentation('Bash', row.call.arguments, row.result),
        message: row.result.structuredError!.message,
        result: row.result,
        rowGrid: indentedGrid(transcriptGrid(WIDTH)),
        isFileChild: false,
        expanded: false,
        stdoutShownBelow: false,
      });
      expect(detail?.lines).toEqual([
        'FAIL-LINE 9',
        'FAIL-LINE 10',
        'FAIL-LINE 11',
        'FAIL-LINE 12',
      ]);
      expect(detail?.hint).toBe('… +8 lines (Ctrl+E)');
    });

    it('hides its cut stdout, so Ctrl+E reaches the row although a newer row hides nothing', async () => {
      const row = await silentFailure(12);
      expect(hides(row)).toBe(true);
      expect(target({ messages: [turn(row, newerOk())] })).toBe(row.call.id);
    });

    it('hides nothing when the whole stdout fits under the row', async () => {
      const row = await silentFailure(2);
      expect(hides(row)).toBe(false);
      expect(target({ messages: [turn(row, newerOk())] })).toBe('newer-ok');
    });
  });
});

describe('mutationDiffPreviewInput', () => {
  const view = { transcriptMode: 'compact', screenReader: false } as const;

  it('previews the first lines of one new file only', () => {
    expect(mutationDiffPreviewInput({ kind: 'create' }, view).createsSingleNewFile).toBe(true);
    expect(
      mutationDiffPreviewInput({ kind: 'create', fileCount: 1 }, view).createsSingleNewFile,
    ).toBe(true);
    expect(
      mutationDiffPreviewInput({ kind: 'create', fileCount: 2 }, view).createsSingleNewFile,
    ).toBe(false);
    expect(mutationDiffPreviewInput({ kind: 'update' }, view).createsSingleNewFile).toBe(false);
    expect(mutationDiffPreviewInput(undefined, view).createsSingleNewFile).toBe(false);
  });

  it('carries the transcript mode and screen reader through', () => {
    expect(
      mutationDiffPreviewInput(
        { kind: 'update' },
        { transcriptMode: 'detailed', screenReader: true },
      ),
    ).toEqual({ createsSingleNewFile: false, transcriptMode: 'detailed', screenReader: true });
  });
});
