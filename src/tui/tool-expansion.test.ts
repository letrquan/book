import { describe, expect, it } from 'vitest';
import { assistantMsg } from '../test/fixtures.js';
import { workloadMessages, workloadRows } from '../test/tool-expand-workload.js';
import type { Message } from '../types/messages.js';
import {
  selectExpandTargetId,
  toolRowHidesContent,
  type ExpandTargetInput,
} from './tool-expansion.js';

const WIDTH = 100;

function target(overrides: Partial<ExpandTargetInput> = {}): string | null {
  return selectExpandTargetId({
    messages: workloadMessages(),
    transcriptMode: 'compact',
    terminalWidth: WIDTH,
    expansionOverrides: new Map(),
    showAllToolOutputIds: new Set(),
    focusedToolId: null,
    automaticToolId: null,
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

  it('lets an active running tool win', () => {
    expect(target({ automaticToolId: 'read-1' })).toBe('read-1');
  });

  it('lets a focused row win until it is in the show-all set', () => {
    expect(target({ focusedToolId: 'read-1' })).toBe('read-1');
    expect(target({ focusedToolId: 'read-1', ...showIn('read-1') })).toBe('edit-long');
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
