import { describe, expect, it } from 'vitest';
import type { ToolResult } from '../types/tools.js';
import { getFileMutationDisplaySummary } from './file-mutation-display.js';

describe('ApplyPatch file mutation display', () => {
  it('aggregates multi-file mutation artifacts for the transcript summary', () => {
    const result: ToolResult = {
      version: 2,
      toolCallId: 'patch-1',
      status: 'success',
      content: '@@ -1 +1 @@\n-old\n+new',
      artifacts: {
        fileMutation: { kind: 'update', filePath: 'a.ts', addedLines: 1, removedLines: 1 },
        fileMutations: [
          { kind: 'update', filePath: 'a.ts', addedLines: 1, removedLines: 1 },
          { kind: 'create', filePath: 'b.ts', addedLines: 2, removedLines: 0 },
        ],
      },
    };
    expect(getFileMutationDisplaySummary('ApplyPatch', {}, result)).toEqual({
      filePath: '2 files',
      kind: 'update',
      addedLines: 3,
      removedLines: 1,
      fileCount: 2,
    });
  });
});
