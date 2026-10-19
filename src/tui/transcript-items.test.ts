import { describe, expect, it } from 'vitest';
import {
  commandOutputPreview,
  COMMAND_PREVIEW_ROWS,
  composeToolHeading,
  deriveToolPresentation,
  labelFailure,
  mutationResultSummary,
  toolResultSummary,
} from './tool-presentation.js';
import { quietRunHeading, summarizeQuietRun } from './quiet-tools.js';
import { RESULT_COLUMN, RESULT_INDENT, resultGrid, transcriptGrid } from './layout.js';
import { displayWidth } from './components/word-wrap.js';
import { ITEM_MARK, PROMPT_MARK, RESULT_MARK } from './marks.js';
import type { ToolResult } from '../types/tools.js';

function success(content: string, extra: Partial<ToolResult> = {}): ToolResult {
  return { version: 2, toolCallId: 'call', status: 'success', content, ...extra };
}

describe('the transcript marks', () => {
  it('are one column each, so every item opens on the same content column', () => {
    for (const mark of [ITEM_MARK, RESULT_MARK, PROMPT_MARK]) expect(displayWidth(mark)).toBe(1);
  });

  it('hangs a result past its connector and two spaces, under the call name', () => {
    const grid = transcriptGrid(73);
    expect(RESULT_INDENT).toBe(displayWidth(`${RESULT_MARK}  `));
    expect(RESULT_COLUMN).toBe(2 + RESULT_INDENT);
    expect(resultGrid(grid).content).toBe(grid.content - RESULT_INDENT);
    expect(resultGrid(grid).label).toBe(0);
  });
});

describe('composeToolHeading', () => {
  it('names a call the way Claude Code does where Book titles it differently', () => {
    expect(composeToolHeading({ title: 'Grep', target: 'memory' }, 70)).toEqual({
      name: 'Search',
      target: 'memory',
    });
    expect(composeToolHeading({ title: 'Edit', target: 'src/a.ts' }, 70).name).toBe('Update');
    expect(composeToolHeading({ title: 'Create', target: 'NEW.md' }, 70).name).toBe('Write');
    expect(composeToolHeading({ title: 'Bash', target: 'ls' }, 70).name).toBe('Bash');
  });

  it('cuts a long argument so the closing parenthesis still fits the row', () => {
    const heading = composeToolHeading({ title: 'Bash', target: 'x'.repeat(200) }, 40);
    expect(heading.target?.endsWith('…')).toBe(true);
    expect(displayWidth(`${heading.name}(${heading.target})`)).toBe(40);
  });

  it('drops an argument with no room for a few characters rather than drawing (…)', () => {
    expect(composeToolHeading({ title: 'Shell output', target: 'abc123' }, 15)).toEqual({
      name: 'Shell output',
    });
  });

  it('folds control characters out of the argument', () => {
    expect(composeToolHeading({ title: 'Bash', target: 'echo a\nrm b' }, 70).target).toBe(
      'echo a rm b',
    );
  });
});

describe('toolResultSummary', () => {
  it('says what a read, a search and a listing found, in words', () => {
    expect(
      toolResultSummary(
        deriveToolPresentation('Read', { file_path: 'a.ts' }, success('1: a\n2: b\n3: c')),
      ),
    ).toBe('Read 3 lines');
    expect(
      toolResultSummary(
        deriveToolPresentation('Grep', { pattern: 'x' }, success('a.ts:1:x\nb.ts:4:x')),
      ),
    ).toBe('Found 2 matches');
    expect(
      toolResultSummary(
        deriveToolPresentation('Glob', { pattern: '*.none' }, success('No files found')),
      ),
    ).toBe('No files');
  });

  it('leaves out what the mark already says and what a finished row no longer shows', () => {
    const presentation = deriveToolPresentation(
      'Read',
      { file_path: 'a.ts' },
      success('1: a', { metrics: { durationMs: 13, retryAttempt: 2 } }),
    );
    expect(presentation.metadata).toContain('13ms');
    expect(toolResultSummary(presentation)).toBe('Read 1 line');
  });

  it('says nothing for a call that did not succeed', () => {
    expect(
      toolResultSummary(deriveToolPresentation('Read', { file_path: 'a.ts' }, undefined)),
    ).toBeUndefined();
  });
});

describe('mutationResultSummary', () => {
  it('puts an edit, a new file and a deletion in words', () => {
    expect(
      mutationResultSummary({ kind: 'update', addedLines: 1, removedLines: 1, fileCount: 1 }),
    ).toBe('Added 1 line, removed 1 line');
    expect(
      mutationResultSummary({ kind: 'update', addedLines: 3, removedLines: 0, fileCount: 1 }),
    ).toBe('Added 3 lines');
    expect(
      mutationResultSummary({ kind: 'create', addedLines: 5, removedLines: 0, fileCount: 1 }),
    ).toBe('Wrote 5 lines');
    expect(
      mutationResultSummary({ kind: 'delete', addedLines: 0, removedLines: 9, fileCount: 1 }),
    ).toBe('Deleted 9 lines');
    expect(
      mutationResultSummary({ kind: 'update', addedLines: 0, removedLines: 0, fileCount: 1 }),
    ).toBe('No changes');
  });

  it('counts the files of a change that spans several', () => {
    expect(
      mutationResultSummary({ kind: 'create', addedLines: 10, removedLines: 2, fileCount: 3 }),
    ).toBe('Changed 3 files, added 10 lines, removed 2 lines');
  });
});

describe('commandOutputPreview', () => {
  it('shows a short output whole', () => {
    expect(commandOutputPreview('one\ntwo\n', 40)).toEqual({
      lines: ['one', 'two'],
      hiddenLines: 0,
    });
  });

  it('keeps the preview inside its rows, the more-lines row counted among them', () => {
    const preview = commandOutputPreview('a\nb\nc\nd\ne\n', 40);
    expect(preview.lines.length + (preview.hiddenLines > 0 ? 1 : 0)).toBe(COMMAND_PREVIEW_ROWS);
    expect(preview.lines[0]).toBe('a');
    expect(preview.lines.length + preview.hiddenLines).toBe(5);
  });

  it('drops blank lines at either end and reports an empty output as no lines', () => {
    expect(commandOutputPreview('\n\n  \n', 40)).toEqual({ lines: [], hiddenLines: 0 });
    expect(commandOutputPreview('\n\nonly\n\n', 40).lines).toEqual(['only']);
  });

  it('never lets a line run past its row, tabs and control characters included', () => {
    const preview = commandOutputPreview('\tcol\x1b[31mred\x1b[0m' + 'x'.repeat(80), 20);
    expect(displayWidth(preview.lines[0]!)).toBeLessThanOrEqual(20);
    expect(preview.lines[0]).not.toContain('\x1b');
    expect(preview.lines[0]).not.toContain('\t');
  });
});

describe('labelFailure', () => {
  it('opens a failure on what kind of stop it was', () => {
    expect(labelFailure('File not found: a.ts', 'failure')).toBe('Error: File not found: a.ts');
    expect(labelFailure('blocked by policy', 'skipped')).toBe('Skipped: blocked by policy');
  });

  it('keeps a message that already says so rather than doubling the label', () => {
    expect(labelFailure('SKIPPED: a.ts has not been read', 'failure')).toBe(
      'SKIPPED: a.ts has not been read',
    );
    expect(labelFailure('Error: boom', 'failure')).toBe('Error: boom');
  });
});

describe('quietRunHeading', () => {
  it('writes a folded run as the calls it stands for', () => {
    const summary = summarizeQuietRun([
      { call: { id: '1', name: 'Grep', arguments: { pattern: 'memory' } } },
      { call: { id: '2', name: 'Read', arguments: { file_path: 'src/settings.ts' } } },
      { call: { id: '3', name: 'Read', arguments: { file_path: 'README.md' } } },
    ]);
    expect(quietRunHeading(summary)).toBe('Search(memory), Read(2 files)');
    expect(summary.files).toEqual(['settings.ts', 'README.md']);
  });

  it('names a single file rather than counting it', () => {
    const summary = summarizeQuietRun([
      { call: { id: '1', name: 'Read', arguments: { file_path: 'src/settings.ts' } } },
    ]);
    expect(quietRunHeading(summary)).toBe('Read(settings.ts)');
  });
});
