import type { Message } from '../types/messages.js';
import type { ToolCall, ToolResult } from '../types/tools.js';
import { assistantMsg } from './fixtures.js';
import { enrichToolResultPresentation, toolFailure } from '../tools/result.js';

/** A 150-line new file: its compact preview keeps 10 lines and hides 140. */
export const NEW_FILE_DIFF = [
  '@@ -0,0 +1,150 @@',
  ...Array.from({ length: 150 }, (_, index) => `+line ${index + 1}`),
].join('\n');

/** A 200-line edit: its compact preview keeps 20 rows and hides 180. */
export const LONG_EDIT_DIFF = [
  '@@ -1,100 +1,100 @@',
  ...Array.from({ length: 100 }, (_, index) => `-old ${index + 1}`),
  ...Array.from({ length: 100 }, (_, index) => `+new ${index + 1}`),
].join('\n');

export const FAILED_STDERR = Array.from(
  { length: 40 },
  (_, i) => `error: assertion ${i + 1} failed in test/case_${i + 1}.test.js: expected 200, got 500`,
).join('\n');

export interface WorkloadRow {
  call: ToolCall;
  result: ToolResult;
  /** Whether the compact transcript draws a `… +N lines` footer for it, by construction. */
  truncated: boolean;
}

function success(
  toolCallId: string,
  content: string,
  fileMutation?: NonNullable<ToolResult['artifacts']>['fileMutation'],
): ToolResult {
  return {
    version: 2,
    toolCallId,
    status: 'success',
    content,
    ...(fileMutation ? { artifacts: { fileMutation } } : {}),
  };
}

/**
 * A successful Read (a body is never drawn for it in the compact transcript), a failed Bash with
 * 40 stderr lines, a 150-line new-file Write, then a capped Edit, oldest first.
 */
export function workloadRows(): WorkloadRow[] {
  return [
    {
      call: { id: 'read-1', name: 'Read', arguments: { filePath: 'src/a.ts' } },
      result: success('read-1', Array.from({ length: 30 }, (_, i) => `row ${i}`).join('\n')),
      truncated: false,
    },
    {
      call: { id: 'bash-fail', name: 'Bash', arguments: { command: 'bash scripts/fail.sh' } },
      result: enrichToolResultPresentation(
        { ...toolFailure(FAILED_STDERR, { details: { exitCode: 1 } }), toolCallId: 'bash-fail' },
        'Bash',
        { command: 'bash scripts/fail.sh' },
      ),
      truncated: true,
    },
    {
      call: { id: 'write-new', name: 'Write', arguments: { filePath: 'src/new.ts' } },
      result: success('write-new', NEW_FILE_DIFF, {
        kind: 'create',
        filePath: 'src/new.ts',
        addedLines: 150,
        removedLines: 0,
      }),
      truncated: true,
    },
    {
      call: { id: 'edit-long', name: 'Edit', arguments: { filePath: 'src/a.ts' } },
      result: success('edit-long', LONG_EDIT_DIFF, {
        kind: 'update',
        filePath: 'src/a.ts',
        addedLines: 100,
        removedLines: 100,
      }),
      truncated: true,
    },
  ];
}

/** The workload as one assistant message. */
export function workloadMessages(rows: readonly WorkloadRow[] = workloadRows()): Message[] {
  return [
    assistantMsg(
      '',
      rows.map((row) => row.call),
      rows.map((row) => row.result),
    ),
  ];
}
