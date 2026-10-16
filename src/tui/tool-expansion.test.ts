import { beforeEach, describe, expect, it, vi } from 'vitest';
import { assistantMsg } from '../test/fixtures.js';
import { workloadMessages, workloadRows } from '../test/tool-expand-workload.js';
import type { Message } from '../types/messages.js';
import { getCompletedTimelineWindow } from './components/ChatPanel.js';
import {
  selectExpandTargetId,
  toolRowHidesContent,
  type ExpandTargetInput,
} from './tool-expansion.js';
import { mutationDiffPreviewInput } from './tool-presentation.js';

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
