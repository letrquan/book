import { describe, expect, it } from 'vitest';
import type { ToolResult } from '../types/tools.js';
import {
  deriveToolPresentation,
  getTranscriptShortcutAction,
  isShortcutsToggleKey,
  parseMcpToolName,
  shouldExpandTool,
} from './tool-presentation.js';
import {
  EXPANDED_OUTPUT_MAX_LINES,
  TOOL_ERROR_EXPANDED_MAX_ROWS,
  composeToolErrorDetail,
  composeToolRow,
  estimateToolErrorDetailRows,
  planMark,
  toolErrorDetailOptions,
} from './tool-presentation.js';
import { CONTROL_CHARACTERS } from '../control-characters.js';
import {
  CONTENT_COLUMN,
  GUTTER_WIDTH,
  MAX_ROW_MEASURE,
  indentedGrid,
  nestedGrid,
  transcriptGrid,
} from './layout.js';
import { displayWidth } from './components/word-wrap.js';
import { enrichToolResultPresentation, toolFailure, toolSuccess } from '../tools/result.js';

type ResultOverrides = Partial<ToolResult> & {
  success?: boolean;
  output?: string;
  error?: string;
  durationMs?: number;
  fileMutation?: NonNullable<ToolResult['artifacts']>['fileMutation'];
};

function result(overrides: ResultOverrides = {}): ToolResult {
  const { success = true, output = '', error, durationMs, fileMutation, ...v2 } = overrides;
  return {
    version: 2,
    toolCallId: 'call',
    status: success ? 'success' : 'error',
    content: output,
    ...(error ? { structuredError: { code: 'test_error', message: error, retryable: false } } : {}),
    ...(durationMs === undefined ? {} : { metrics: { durationMs } }),
    ...(fileMutation ? { artifacts: { fileMutation } } : {}),
    ...v2,
  };
}

describe('deriveToolPresentation', () => {
  it('builds compact create and update summaries from structured mutation metadata', () => {
    const create = deriveToolPresentation(
      'Write',
      { filePath: 'src/new.ts' },
      result({
        output: '@@ -0,0 +1,2 @@\n+one\n+two',
        fileMutation: {
          kind: 'create',
          filePath: 'src/new.ts',
          addedLines: 2,
          removedLines: 0,
        },
      }),
    );
    expect(create.summary).toBe('Create(src/new.ts) · +2');

    expect(
      deriveToolPresentation(
        'Edit',
        { filePath: 'src/a.ts' },
        result({
          output: '@@ -1 +1 @@\n-old\n+new',
          fileMutation: {
            kind: 'update',
            filePath: 'src/a.ts',
            addedLines: 1,
            removedLines: 1,
          },
        }),
      ).summary,
    ).toBe('Edit(src/a.ts) · +1 -1');
  });

  it('derives legacy diffstats without changing persisted tool results', () => {
    expect(
      deriveToolPresentation(
        'edit_file',
        { file_path: 'src/legacy.ts' },
        result({ output: '@@ -1 +1,2 @@\n-old\n+new\n+extra' }),
      ).summary,
    ).toBe('Edit(src/legacy.ts) · +2 -1');
  });

  it('summarizes read ranges, search counts, command output, and duration', () => {
    expect(
      deriveToolPresentation(
        'Read',
        { filePath: 'src/a.ts', offset: 10 },
        result({ output: 'a\nb\nc' }),
      ).summary,
    ).toBe('Read(src/a.ts) · 3 lines 10-12');
    expect(
      deriveToolPresentation('Glob', { pattern: '*.ts' }, result({ output: '' })).summary,
    ).toBe('Glob(*.ts) · 0 files');
    expect(
      deriveToolPresentation(
        'Bash',
        { command: 'npm test' },
        result({ output: 'passed', durationMs: 1250 }),
      ).summary,
    ).toBe('Bash(npm test) · 1 line 1.3s');
    expect(deriveToolPresentation('Bash', { command: 'npm test' }).hasHiddenContent).toBe(false);
  });

  it('uses domains for fetches and reports task activity without raw trace JSON', () => {
    expect(
      deriveToolPresentation(
        'WebFetch',
        { url: 'https://docs.example.com/path' },
        result({ output: '# Docs' }),
      ).summary,
    ).toBe('Fetch(docs.example.com)');
    expect(
      deriveToolPresentation('Task', { agent: 'reviewer' }, undefined, {
        nestedActivityCount: 3,
      }).summary,
    ).toBe('Task(reviewer) · 3 activities');
  });

  it('keeps failure state inline in a collapsed summary', () => {
    const presentation = deriveToolPresentation(
      'Bash',
      { command: 'npm test' },
      result({ success: false, error: 'tests failed', durationMs: 500 }),
    );
    expect(presentation.status).toBe('failure');
    expect(presentation.summary).toBe('Bash(npm test) · failed 500ms');
  });

  it('does not treat raw arguments as expandable transcript content', () => {
    const presentation = deriveToolPresentation(
      'Edit',
      { filePath: 'src/a.ts', oldString: 'old', newString: 'new' },
      result({ success: false, error: 'old string not found' }),
    );
    expect(presentation.hasHiddenContent).toBe(false);
  });
});

describe('MCP presentation', () => {
  it('parses names and preserves one summary per invocation', () => {
    expect(parseMcpToolName('mcp__team_slack__search_messages')).toEqual({
      server: 'team_slack',
      tool: 'search messages',
    });
    expect(
      deriveToolPresentation('mcp__slack__search', { query: 'release' }, result()).summary,
    ).toBe('Called slack(search)');
    expect(deriveToolPresentation('mcp__slack__post', { channel: 'eng' }, result()).summary).toBe(
      'Called slack(post)',
    );
  });
});

describe('tool expansion policy', () => {
  it('combines transcript mode, automatic previews, explicit overrides, and accessibility', () => {
    const overrides = new Map<string, boolean>();
    expect(
      shouldExpandTool({
        mode: 'compact',
        toolId: 'active',
        automaticToolId: 'active',
        expansionOverrides: overrides,
      }),
    ).toBe(true);
    expect(
      shouldExpandTool({
        mode: 'compact',
        toolId: 'other',
        automaticToolId: 'active',
        defaultExpanded: true,
        expansionOverrides: overrides,
      }),
    ).toBe(true);
    expect(
      shouldExpandTool({
        mode: 'compact',
        toolId: 'other',
        automaticToolId: 'active',
        defaultExpanded: true,
        expansionOverrides: new Map([['other', false]]),
      }),
    ).toBe(false);
    expect(
      shouldExpandTool({
        mode: 'detailed',
        toolId: 'other',
        automaticToolId: null,
        expansionOverrides: overrides,
      }),
    ).toBe(true);
    expect(
      shouldExpandTool({
        mode: 'detailed',
        toolId: 'other',
        automaticToolId: null,
        expansionOverrides: new Map([['other', false]]),
      }),
    ).toBe(false);
    expect(
      shouldExpandTool({
        mode: 'compact',
        toolId: 'other',
        automaticToolId: null,
        expansionOverrides: new Map([['other', false]]),
        screenReader: true,
      }),
    ).toBe(true);
  });
});

describe('transcript shortcuts', () => {
  it('toggles detailed mode and maps context-sensitive output expansion', () => {
    expect(getTranscriptShortcutAction('compact', 'o', { ctrl: true })).toBe('enter-detailed');
    expect(getTranscriptShortcutAction('detailed', 'o', { ctrl: true })).toBe('exit-detailed');
    expect(getTranscriptShortcutAction('detailed', '', { escape: true })).toBe('exit-detailed');
    expect(getTranscriptShortcutAction('detailed', 'q', {})).toBe('exit-detailed');
    expect(getTranscriptShortcutAction('compact', 'q', {})).toBeNull();
    expect(getTranscriptShortcutAction('compact', 'e', { ctrl: true })).toBe('expand-output');
    expect(getTranscriptShortcutAction('detailed', String.fromCharCode(5), { ctrl: true })).toBe(
      'expand-output',
    );
  });
});

describe('isShortcutsToggleKey', () => {
  // Ink's parseKeypress reports the byte a terminal sends for Ctrl+/ as
  // `{ name: '', ctrl: false }`, so it reaches useInput as a bare US character
  // with no modifier flag. Asserting only the synthesized `{ ctrl: true }` form
  // is what let the shortcut die while its test stayed green: this case is the
  // one that reflects a real keypress.
  it('matches the raw US byte a terminal sends for Ctrl+/', () => {
    expect(isShortcutsToggleKey('', {})).toBe(true);
    expect(isShortcutsToggleKey(String.fromCharCode(31), { ctrl: false })).toBe(true);
  });

  it('still matches terminals that report the modifier', () => {
    expect(isShortcutsToggleKey('/', { ctrl: true })).toBe(true);
    expect(isShortcutsToggleKey('_', { ctrl: true })).toBe(true);
  });

  it('ignores an ordinary slash and Alt chords', () => {
    expect(isShortcutsToggleKey('/', {})).toBe(false);
    expect(isShortcutsToggleKey('/', { ctrl: true, meta: true })).toBe(false);
    expect(isShortcutsToggleKey('', {})).toBe(false);
    expect(isShortcutsToggleKey('o', { ctrl: true })).toBe(false);
  });
});

describe('composeToolRow', () => {
  const grid = transcriptGrid(100);

  function render(row: ReturnType<typeof composeToolRow>): string {
    return `${row.label}${row.label ? ' ' : ''}${row.target}${row.gap}${row.meta}`;
  }

  it('bounds the aligned measure so metadata stays near its target', () => {
    // Prose takes the whole terminal; these columns do not. Right-aligning
    // `31ms` against column 197 does not align it with the command it timed.
    const wide = transcriptGrid(200);
    const row = composeToolRow(
      { title: 'Glob', target: 'src/tui/*.ts', metadata: ['53 files'] },
      wide,
      { elapsed: '31ms' },
    );
    expect(displayWidth(render(row))).toBe(MAX_ROW_MEASURE);
    expect(displayWidth(row.gap)).toBeLessThan(MAX_ROW_MEASURE);

    // Still one column, though: the rows agree with each other at any width.
    const sibling = composeToolRow(
      { title: 'Read', target: 'src/tui/layout.ts', metadata: ['161 lines'] },
      wide,
    );
    expect(displayWidth(render(sibling))).toBe(displayWidth(render(row)));
  });

  it('keeps a nested row ending on its parent edge at any width', () => {
    // indentedGrid exists to hold the right edge still as rows nest. A row
    // measure clamped flat to MAX_ROW_MEASURE regardless of depth would let a
    // child, which starts two columns further in, end two columns further out.
    for (const width of [100, 120, 200, 400]) {
      const base = transcriptGrid(width);
      const indented = indentedGrid(base);
      const nested = nestedGrid(indented);
      const end = (grid: ReturnType<typeof transcriptGrid>, depth: number) =>
        CONTENT_COLUMN +
        GUTTER_WIDTH * depth +
        displayWidth(
          render(
            composeToolRow({ title: 'Read', target: 'src/a.ts', metadata: ['8 lines'] }, grid),
          ),
        );
      expect(end(indented, 1)).toBe(end(base, 0));
      expect(end(nested, 2)).toBe(end(base, 0));
    }
  });

  it('right-aligns metadata to the same column across rows', () => {
    const rows = [
      composeToolRow(
        { title: 'Read', target: 'src/tui/persist.test.ts', metadata: ['8 lines'] },
        grid,
      ),
      composeToolRow({ title: 'Grep', target: 'writeAtomic', metadata: ['2 matches'] }, grid),
      composeToolRow(
        { title: 'Edit', target: 'a/very/long/path/to/some/file.ts', metadata: ['+3', '-2'] },
        grid,
      ),
    ];
    const ends = rows.map((row) => displayWidth(render(row)));
    expect(new Set(ends).size).toBe(1);
    expect(ends[0]).toBe(grid.content);
  });

  it('pads every label to the same width so targets line up', () => {
    const read = composeToolRow({ title: 'Read', target: 'a.ts', metadata: [] }, grid);
    const search = composeToolRow({ title: 'Search web', target: 'b.ts', metadata: [] }, grid);
    expect(displayWidth(read.label)).toBe(displayWidth(search.label));
    expect(displayWidth(read.label)).toBe(grid.label);
  });

  it('shortens labels that would overflow the column', () => {
    const row = composeToolRow({ title: 'Edit notebook', target: 'nb.ipynb', metadata: [] }, grid);
    expect(row.label.trim()).toBe('Notebook');
    expect(displayWidth(row.label)).toBe(grid.label);
  });

  it('runs the label inline when the terminal is too narrow for a column', () => {
    const narrow = transcriptGrid(60);
    const row = composeToolRow(
      { title: 'Read', target: 'src/a.ts', metadata: ['3 lines'] },
      narrow,
    );
    expect(row.label).toBe('');
    expect(row.target).toContain('Read ');
    expect(row.target).toContain('src/a.ts');
  });

  it('folds the control characters out of a failure text, not only out of a target', () => {
    // The error is the model's own or a tool's, and the text of an
    // `invalid_json_arguments` failure quotes the model's raw arguments: a newline,
    // an ESC and a bidi override all reach it. `match`, not `test` — CONTROL_CHARACTERS
    // is global, and `test` would advance lastIndex between assertions.
    const detail = composeToolErrorDetail(
      { title: 'Edit', target: 'src/tools/file.ts' },
      ['bad\nthing', String.fromCharCode(0x202e), 'here'].join(''),
      grid,
    );
    expect(detail.lines.join(' ').match(CONTROL_CHARACTERS)).toBeNull();
    expect(detail.lines).toEqual(['bad thing here']);
  });

  it('keeps the metadata in its column on a failure', () => {
    const row = composeToolRow({ title: 'Bash', target: 'npm test', metadata: ['failed'] }, grid);
    expect(row.meta).toBe('failed');
  });

  it('never exceeds the content budget, at any width', () => {
    for (const width of [20, 32, 61, 76, 100, 200]) {
      const g = transcriptGrid(width);
      const row = composeToolRow(
        {
          title: 'Apply patch',
          target: 'a/deeply/nested/path/that/keeps/going/and/going/file.tsx',
          metadata: ['+128', '-64', '2.4s'],
        },
        g,
      );
      expect(displayWidth(render(row))).toBeLessThanOrEqual(g.content);
    }
  });
});

describe('composeToolErrorDetail', () => {
  const grid = transcriptGrid(100);
  /** The columns a message has once it starts at `column`. */
  const room = (g: typeof grid, column: number) => g.row - (column - GUTTER_WIDTH);

  it('sets the message under the target, past the label column', () => {
    // The message replaced the row's metadata and was cut to that column:
    // `Invalid arguments for TodoWrite: arguments.todos is required. A…`.
    const detail = composeToolErrorDetail(
      { title: 'Bash', target: 'npm test' },
      'exit code 1',
      grid,
    );
    expect(detail.column).toBe(GUTTER_WIDTH + grid.label + 1);
    expect(detail.lines).toEqual(['exit code 1']);
  });

  it('starts under the verb when the row shows no target', () => {
    // `× Steps` names nothing to sit under; a message hung at the target column
    // floated away from its row.
    const detail = composeToolErrorDetail({ title: 'Steps', target: undefined }, 'bad plan', grid);
    expect(detail.column).toBe(GUTTER_WIDTH);
  });

  it('starts under the verb when the label runs inline', () => {
    const narrow = transcriptGrid(40);
    expect(narrow.label).toBe(0);
    const row = { title: 'Bash', target: 'npm test' };
    expect(composeToolErrorDetail(row, 'exit code 1', narrow).column).toBe(GUTTER_WIDTH);
  });

  it('starts under the verb, never past the row, when the target column is too narrow', () => {
    // A wrap measure clamped up to a minimum ran past the row, and Ink cut every
    // line at the box edge: the middle of the message never showed.
    const tight = { ...grid, row: 20 };
    const detail = composeToolErrorDetail(
      { title: 'Bash', target: 'npm test' },
      'Invalid arguments for Bash: arguments.description is not allowed.',
      tight,
    );
    expect(detail.column).toBe(GUTTER_WIDTH);
    for (const line of detail.lines) expect(displayWidth(line)).toBeLessThanOrEqual(tight.row);
  });

  it('wraps a long message to the row, keeping the words that say what was wrong', () => {
    const message =
      'Invalid arguments for TodoWrite: arguments.todos is required. Allowed arguments: todos.';
    const narrow = transcriptGrid(60);
    const detail = composeToolErrorDetail({ title: 'Steps', target: undefined }, message, narrow);
    expect(detail.lines.length).toBeGreaterThan(1);
    expect(detail.lines.join(' ')).toBe(message);
    for (const line of detail.lines) {
      expect(displayWidth(line)).toBeLessThanOrEqual(room(narrow, detail.column));
    }
  });

  it('stops at two lines and marks the cut', () => {
    const detail = composeToolErrorDetail(
      { title: 'Bash', target: 'x' },
      'word '.repeat(200),
      grid,
    );
    expect(detail.lines).toHaveLength(2);
    expect(detail.lines[1]!.endsWith('…')).toBe(true);
    for (const line of detail.lines) {
      expect(displayWidth(line)).toBeLessThanOrEqual(room(grid, detail.column));
    }
  });

  it('measures wide characters by the columns they take', () => {
    const detail = composeToolErrorDetail(
      { title: 'Bash', target: 'x' },
      `error-${'🙂'.repeat(80)}`,
      grid,
    );
    for (const line of detail.lines) {
      expect(displayWidth(line)).toBeLessThanOrEqual(room(grid, detail.column));
    }
  });
});

describe('composeToolErrorDetail with a failed command', () => {
  const grid = transcriptGrid(100);
  const row = { title: 'Bash', target: 'bash scripts/fail.sh' };
  const command = { commandOutput: true };
  const room = grid.row - grid.label - 1;
  const assertion = (n: number) =>
    `error: assertion ${n} failed in test/case_${n}.test.js: expected 200, got 500`;
  const source = (count: number) => Array.from({ length: count }, (_, i) => assertion(i + 1));
  const rows = (detail: ReturnType<typeof composeToolErrorDetail>) =>
    (detail.hint ? 1 : 0) + detail.lines.length + (detail.note?.length ?? 0);

  it('folds and wraps a multi-line message that is not command output, as it always did', () => {
    // An MCP failure or a validation message names its cause on the first line.
    const message = 'MCP tool x failed: connection refused\n(stderr: dial tcp 127.0.0.1:1)\n';
    const detail = composeToolErrorDetail(row, message, grid);
    expect(detail.hint).toBeUndefined();
    expect(detail.note).toBeUndefined();
    expect(detail.lines).toEqual([
      'MCP tool x failed: connection refused (stderr: dial tcp 127.0.0.1:1)',
    ]);

    const long = composeToolErrorDetail(row, source(40).join('\n'), grid);
    expect(long.hint).toBeUndefined();
    expect(long.lines).toHaveLength(2);
    expect(long.lines[0]!.startsWith(assertion(1))).toBe(true);
    expect(long.lines[1]!.endsWith('…')).toBe(true);
  });

  it('keeps the last four lines of a long failure, one row each, behind a count of the rest', () => {
    const detail = composeToolErrorDetail(row, source(40).join('\n'), grid, command);
    expect(detail.hint).toBe('… +36 lines (Ctrl+E)');
    expect(detail.lines).toEqual([assertion(37), assertion(38), assertion(39), assertion(40)]);
    for (const line of detail.lines) expect(displayWidth(line)).toBeLessThanOrEqual(room);
  });

  it('shows a short failure whole, line by line, with no hint', () => {
    const detail = composeToolErrorDetail(row, 'first\nsecond\nthird\n\n', grid, command);
    expect(detail.hint).toBeUndefined();
    expect(detail.lines).toEqual(['first', 'second', 'third']);
  });

  it('shows exactly four lines whole', () => {
    const detail = composeToolErrorDetail(row, source(4).join('\n'), grid, command);
    expect(detail.hint).toBeUndefined();
    expect(detail.lines).toEqual(source(4));
  });

  it('shows a stack trace tail with no blank row, and counts only non-blank hidden lines', () => {
    const stderr = 'Error: boom\n    at A\n    at B\n    at C\n\nNode.js v22';
    const detail = composeToolErrorDetail(row, stderr, grid, command);
    expect(detail.lines).toEqual(['    at A', '    at B', '    at C', 'Node.js v22']);
    expect(detail.hint).toBe('… +1 line (Ctrl+E)');

    const spaced = composeToolErrorDetail(
      row,
      'one\n\n  \ntwo\n\n\nthree\n \t\nfour\n\nfive',
      grid,
      command,
    );
    expect(spaced.lines).toEqual(['two', 'three', 'four', 'five']);
    expect(spaced.hint).toBe('… +1 line (Ctrl+E)');
  });

  it('truncates a long line to its row instead of wrapping it', () => {
    const detail = composeToolErrorDetail(row, `short\n${'x'.repeat(300)}`, grid, command);
    expect(detail.lines).toHaveLength(2);
    expect(detail.lines[1]!.endsWith('…')).toBe(true);
    expect(displayWidth(detail.lines[1]!)).toBeLessThanOrEqual(room);
  });

  it('neutralises an escape sequence inside a line', () => {
    const detail = composeToolErrorDetail(
      row,
      'ok\n\u001b[31mred\u001b[0m text\nlast',
      grid,
      command,
    );
    for (const line of detail.lines) expect(line.match(CONTROL_CHARACTERS)).toBeNull();
    expect(detail.lines).toEqual(['ok', ' [31mred [0m text', 'last']);
  });

  it('splits CRLF line endings', () => {
    const detail = composeToolErrorDetail(row, 'one\r\ntwo\r\nthree', grid, command);
    expect(detail.hint).toBeUndefined();
    expect(detail.lines).toEqual(['one', 'two', 'three']);
  });

  it('shows the tail of stdout when the message is only the exit code', () => {
    const stdout = source(12).join('\n');
    const detail = composeToolErrorDetail(row, 'Exit code: 1', grid, {
      ...command,
      stdout: `${stdout}\n\n`,
    });
    expect(detail.hint).toBe('… +8 lines (Ctrl+E)');
    expect(detail.lines).toEqual(source(12).slice(8));
    expect(detail.lines.join('\n')).not.toContain('Exit code');
  });

  it('shows no rows when the message is only the exit code and stdout is empty', () => {
    for (const stdout of [undefined, '', '\n  \n']) {
      const detail = composeToolErrorDetail(row, ' Exit code: 2\n', grid, { ...command, stdout });
      expect(detail.lines).toEqual([]);
      expect(detail.hint).toBeUndefined();
      expect(detail.note).toBeUndefined();
    }
  });

  it('keeps the message when stderr said more than the exit code', () => {
    const detail = composeToolErrorDetail(row, 'Exit code: 1\nboom', grid, {
      ...command,
      stdout: 'ignored',
    });
    expect(detail.lines).toEqual(['Exit code: 1', 'boom']);
  });

  describe('the sandbox note', () => {
    const note =
      "Note: the repository's git directory is read-only inside the sandbox " +
      '(sandbox.filesystem.allowGitWrites is off), so git cannot write to it here. Do not retry the ' +
      'command or change sandbox settings yourself; tell the user it has to run outside the sandbox.';

    it('is wrapped to two rows after the tail, and takes none of the four tail slots', () => {
      const detail = composeToolErrorDetail(
        row,
        `${source(10).join('\n')}\n${note}`,
        grid,
        command,
      );
      expect(detail.lines).toEqual(source(10).slice(6));
      expect(detail.hint).toBe('… +6 lines (Ctrl+E)');
      expect(detail.note).toHaveLength(2);
      expect(detail.note![0]!.startsWith('Note: the repository')).toBe(true);
      expect(detail.note![1]!.endsWith('…')).toBe(true);
      for (const line of detail.note!) expect(displayWidth(line)).toBeLessThanOrEqual(room);
      expect(rows(detail)).toBeLessThanOrEqual(7);
    });

    it('stays whole when it fits in two rows', () => {
      const detail = composeToolErrorDetail(
        row,
        'git failed\nNote: run it outside.\n',
        grid,
        command,
      );
      expect(detail.lines).toEqual(['git failed']);
      expect(detail.note).toEqual(['Note: run it outside.']);
    });

    it('does not stand in for the exit code: stdout still shows under it', () => {
      const detail = composeToolErrorDetail(row, 'Exit code: 1\nNote: run it outside.', grid, {
        ...command,
        stdout: 'fatal: Unable to create index.lock',
      });
      expect(detail.lines).toEqual(['fatal: Unable to create index.lock']);
      expect(detail.note).toEqual(['Note: run it outside.']);
    });

    it('is only recognised as the last line, and never in prose', () => {
      const inside = composeToolErrorDetail(row, 'Note: first\nthen more', grid, command);
      expect(inside.note).toBeUndefined();
      expect(inside.lines).toEqual(['Note: first', 'then more']);
      const prose = composeToolErrorDetail(row, 'boom\nNote: x', grid);
      expect(prose.note).toBeUndefined();
      expect(prose.lines).toEqual(['boom Note: x']);
    });
  });

  describe('expanded', () => {
    const expanded = { ...command, expanded: true };
    const note =
      'Note: the repository git directory is read-only inside the sandbox, so git cannot write ' +
      'to it here. Do not retry the command or change sandbox settings yourself; tell the user ' +
      'it has to run outside the sandbox.';

    it('shows every line of a long failure, one row each, in order, with no hint', () => {
      const detail = composeToolErrorDetail(row, source(40).join('\n'), grid, expanded);
      expect(detail.hint).toBeUndefined();
      expect(detail.lines).toEqual(source(40));
      for (const line of detail.lines) expect(displayWidth(line)).toBeLessThanOrEqual(room);
    });

    it('neutralises an escape byte inside a line', () => {
      const lines = source(40);
      lines[10] = 'bad \u001b[31mred\u001b[0m line';
      const detail = composeToolErrorDetail(row, lines.join('\n'), grid, expanded);
      expect(detail.lines).toHaveLength(40);
      for (const line of detail.lines) expect(line.match(CONTROL_CHARACTERS)).toBeNull();
      expect(detail.lines[10]).toBe('bad  [31mred [0m line');
    });

    it('continues a long line on the rows after it, losing none of it', () => {
      const long = 'abcdefghij'.repeat(Math.ceil((room * 3) / 10)).slice(0, room * 3);
      const detail = composeToolErrorDetail(row, `short\n${long}`, grid, expanded);
      expect(detail.lines).toHaveLength(4);
      expect(detail.lines[0]).toBe('short');
      expect(detail.lines.slice(1)).toHaveLength(3);
      expect(detail.lines.slice(1).join('')).toBe(long);
      for (const line of detail.lines) expect(displayWidth(line)).toBeLessThanOrEqual(room);
      // The collapsed detail still cuts it to one row.
      const collapsed = composeToolErrorDetail(row, `short\n${long}`, grid, command);
      expect(collapsed.lines).toHaveLength(2);
      expect(collapsed.lines[1]!.endsWith('…')).toBe(true);
    });

    it('wraps CJK and emoji by display width', () => {
      const long = '漢字🙂'.repeat(room);
      const detail = composeToolErrorDetail(row, long, grid, expanded);
      expect(detail.lines.length).toBeGreaterThan(1);
      expect(detail.lines.join('')).toBe(long);
      for (const line of detail.lines) expect(displayWidth(line)).toBeLessThanOrEqual(room);
    });

    it('keeps the last rows of wrapped output within the bound, and counts the hidden lines', () => {
      const wide = (n: number) => `${n}`.padStart(4, '0') + 'x'.repeat(room * 2 - 4);
      const lines = Array.from({ length: 1500 }, (_, i) => wide(i + 1));
      const detail = composeToolErrorDetail(row, lines.join('\n'), grid, expanded);
      expect(detail.lines).toHaveLength(EXPANDED_OUTPUT_MAX_LINES);
      expect(detail.lines.at(-1)).toBe(lines.at(-1)!.slice(room));
      expect(detail.lines.slice(-2).join('')).toBe(lines.at(-1));
      // 2000 rows hold 1000 whole lines; the 500 before them are hidden.
      expect(detail.hint).toBe('… +500 lines');
      expect(rows(detail)).toBeLessThanOrEqual(TOOL_ERROR_EXPANDED_MAX_ROWS);
    });

    it('counts a line the bound cuts into as hidden, and keeps its last rows', () => {
      const long = 'y'.repeat(room * 2500);
      const detail = composeToolErrorDetail(row, `first\n${long}`, grid, expanded);
      expect(detail.lines).toHaveLength(EXPANDED_OUTPUT_MAX_LINES);
      expect(detail.hint).toBe('… +2 lines');
      expect(detail.lines.every((line) => line === 'y'.repeat(room))).toBe(true);
    });

    it('shows no stdout fallback when the output block draws that stdout below', () => {
      const stdout = source(12).join('\n');
      const detail = composeToolErrorDetail(row, 'Exit code: 1', grid, {
        ...expanded,
        stdout,
        stdoutShownBelow: true,
      });
      expect(detail.lines).toEqual([]);
      expect(detail.hint).toBeUndefined();
      const withNote = composeToolErrorDetail(row, 'Exit code: 1\nNote: run it outside.', grid, {
        ...expanded,
        stdout,
        stdoutShownBelow: true,
      });
      expect(withNote.lines).toEqual([]);
      expect(withNote.note).toEqual(['Note: run it outside.']);
    });

    it('keeps the collapsed stdout tail and real stderr even when stdout shows below', () => {
      const stdout = source(12).join('\n');
      const collapsed = composeToolErrorDetail(row, 'Exit code: 1', grid, {
        ...command,
        stdout,
        stdoutShownBelow: true,
      });
      expect(collapsed.lines).toEqual(source(12).slice(8));
      expect(collapsed.hint).toBe('… +8 lines (Ctrl+E)');
      const stderr = composeToolErrorDetail(row, 'Exit code: 1\nboom', grid, {
        ...expanded,
        stdout,
        stdoutShownBelow: true,
      });
      expect(stderr.lines).toEqual(['Exit code: 1', 'boom']);
    });

    it('keeps the last 2000 lines and counts the rest, naming no key', () => {
      const detail = composeToolErrorDetail(row, source(2500).join('\n'), grid, expanded);
      expect(detail.hint).toBe('… +500 lines');
      expect(detail.lines).toHaveLength(EXPANDED_OUTPUT_MAX_LINES);
      expect(detail.lines[0]).toBe(assertion(501));
      expect(detail.lines.at(-1)).toBe(assertion(2500));
    });

    it('shows stdout in full when the message is only the exit code', () => {
      const detail = composeToolErrorDetail(row, 'Exit code: 1', grid, {
        ...expanded,
        stdout: `${source(12).join('\n')}\n\n`,
      });
      expect(detail.hint).toBeUndefined();
      expect(detail.lines).toEqual(source(12));
    });

    it('still ends with the sandbox note, wrapped to two rows', () => {
      const detail = composeToolErrorDetail(
        row,
        `${source(20).join('\n')}\n${note}`,
        grid,
        expanded,
      );
      expect(detail.hint).toBeUndefined();
      expect(detail.lines).toEqual(source(20));
      expect(detail.note!.length).toBeGreaterThan(0);
      expect(detail.note!.length).toBeLessThanOrEqual(2);
      expect(detail.note![0]!.startsWith('Note: the repository')).toBe(true);
    });

    it('wraps prose past two rows, to at most 2000', () => {
      const prose = 'word '.repeat(200);
      const collapsed = composeToolErrorDetail(row, prose, grid);
      expect(collapsed.lines).toHaveLength(2);
      const detail = composeToolErrorDetail(row, prose, grid, { expanded: true });
      expect(detail.lines.length).toBeGreaterThan(2);
      expect(detail.lines.join(' ')).toBe(prose.trim());
      const huge = composeToolErrorDetail(row, 'word '.repeat(60_000), grid, { expanded: true });
      expect(huge.lines).toHaveLength(EXPANDED_OUTPUT_MAX_LINES);
    });
  });

  describe('the row budget', () => {
    const output = `${source(10).join('\n')}\nNote: ${'word '.repeat(80)}`;

    it('defaults to a hint, four tail rows and two note rows', () => {
      expect(rows(composeToolErrorDetail(row, output, grid, command))).toBe(7);
    });

    it('is never exceeded, at any size', () => {
      for (let maxRows = 0; maxRows <= 9; maxRows++) {
        const detail = composeToolErrorDetail(row, output, grid, { ...command, maxRows });
        expect(rows(detail)).toBeLessThanOrEqual(maxRows);
      }
    });

    it('drops the hint first, then the top of the tail', () => {
      const plain = source(10).join('\n');
      const at = (maxRows: number) =>
        composeToolErrorDetail(row, plain, grid, { ...command, maxRows });
      expect(at(5).hint).toBe('… +6 lines (Ctrl+E)');
      expect(at(4).hint).toBeUndefined();
      expect(at(4).lines).toEqual(source(10).slice(6));
      expect(at(2).lines).toEqual(source(10).slice(8));
      expect(at(2).hint).toBeUndefined();
    });

    it('keeps one tail row ahead of the note when the budget is that small', () => {
      const detail = composeToolErrorDetail(row, output, grid, { ...command, maxRows: 2 });
      expect(detail.lines).toEqual([assertion(10)]);
      expect(detail.note).toHaveLength(1);
      expect(detail.note![0]!.endsWith('…')).toBe(true);
    });
  });
});

describe('estimateToolErrorDetailRows', () => {
  const failure = (message: string, content = '', details?: Record<string, unknown>) =>
    toolFailure(message, { content, ...(details ? { details } : {}) });
  const lines = (count: number) =>
    Array.from({ length: count }, (_, i) => `line ${i + 1}`).join('\n');

  it('is 0 for a success and for a call with no result yet', () => {
    expect(estimateToolErrorDetailRows(toolSuccess('fine'))).toBe(0);
    expect(estimateToolErrorDetailRows(undefined)).toBe(0);
  });

  it('is two for a failure that is not command output', () => {
    expect(estimateToolErrorDetailRows(failure('a\nb\nc\nd\ne\nf'))).toBe(2);
  });

  it('is one row per non-blank line of command output, and five at most', () => {
    const rows = (message: string) =>
      estimateToolErrorDetailRows(failure(message, '', { exitCode: 1 }));
    expect(rows('boom')).toBe(1);
    expect(rows(`${lines(3)}\n\n`)).toBe(3);
    expect(rows(lines(4))).toBe(4);
    expect(rows(lines(5))).toBe(5);
    expect(rows(lines(500))).toBe(5);
    expect(rows(`a\n\n\nb`)).toBe(2);
  });

  it('adds two rows for the sandbox note, which takes no tail slot', () => {
    const rows = (message: string) =>
      estimateToolErrorDetailRows(failure(message, '', { exitCode: 1 }));
    expect(rows(`${lines(2)}\nNote: run it outside.`)).toBe(4);
    expect(rows(`${lines(40)}\nNote: run it outside.`)).toBe(7);
  });

  it('reads stdout when the message is only the exit code', () => {
    const rows = (content: string, message = 'Exit code: 1') =>
      estimateToolErrorDetailRows(failure(message, content, { exitCode: 1 }));
    expect(rows(lines(12))).toBe(5);
    expect(rows(lines(2))).toBe(2);
    expect(rows('')).toBe(0);
    expect(rows(lines(12), 'Exit code: 1\nNote: run it outside.')).toBe(7);
  });

  it('agrees with the rows composeToolErrorDetail draws', () => {
    const grid = transcriptGrid(100);
    const row = { title: 'Bash', target: 'npm test' };
    const wide = 'x'.repeat(40);
    const cases: [string, string][] = [
      ['boom', ''],
      [lines(3), ''],
      [lines(9), ''],
      ['Exit code: 1', lines(12)],
      ['Exit code: 1', ''],
      [`${lines(9)}\nNote: ${wide} ${wide} ${wide} ${wide}`, ''],
    ];
    for (const [message, content] of cases) {
      const result = failure(message, content, { exitCode: 1 });
      const detail = composeToolErrorDetail(row, message, grid, toolErrorDetailOptions(result));
      const drawn = (detail.hint ? 1 : 0) + detail.lines.length + (detail.note?.length ?? 0);
      expect(estimateToolErrorDetailRows(result)).toBeGreaterThanOrEqual(drawn);
      expect(estimateToolErrorDetailRows(result)).toBeLessThanOrEqual(drawn + 1);
    }
  });
});

describe('planMark', () => {
  const todo = (status: 'pending' | 'in_progress' | 'completed') => ({
    content: `step ${status}`,
    status,
  });

  it('marks a plan set out but not begun', () => {
    expect(planMark([todo('pending'), todo('pending')])).toBe('◌');
  });

  it('marks a plan under way, not a step done', () => {
    // `✓ Steps  Clone the repo   0 of 3 done` read as the opposite of its own text.
    expect(planMark([todo('in_progress'), todo('pending')])).toBe('◔');
    expect(planMark([todo('completed'), todo('pending')])).toBe('◔');
  });

  it('checks a finished plan', () => {
    expect(planMark([todo('completed'), todo('completed')])).toBe('✓');
  });

  it('leaves an empty plan to the status glyph', () => {
    expect(planMark([])).toBeUndefined();
  });
});

describe('composeToolRow label column', () => {
  const grid = transcriptGrid(100);

  it('never truncates the verb; an oversized label runs inline', () => {
    const row = composeToolRow(
      { title: 'A tool with a very long name', target: 'src/a.ts', metadata: [] },
      grid,
    );
    expect(row.label).toBe('');
    expect(row.target).toContain('A tool with a very long name');
    expect(row.target).not.toContain('…');
  });

  it('drops the redundant "Called" verb from an MCP row', () => {
    const row = composeToolRow({ title: 'Called slack', target: 'search', metadata: [] }, grid);
    expect(row.label.trim()).toBe('slack');
    expect(row.target).toBe('search');
  });
});

describe('composeToolRow inline-label budget', () => {
  it('spends every free column on the target when the label runs inline', () => {
    // The budget covers prefix + target together; charging for the prefix twice
    // clipped the command early and padded the columns back as spaces.
    const grid = transcriptGrid(60);
    const row = composeToolRow(
      { title: 'Bash', target: 'x'.repeat(200), metadata: ['failed'] },
      grid,
    );
    expect(row.label).toBe('');
    expect(displayWidth(`${row.target}${row.gap}${row.meta}`)).toBe(grid.content);
    // One column of gap before the metadata, and no run of padding beyond it.
    expect(row.gap).toBe(' ');
  });
});

describe('Read row line count', () => {
  it('does not count the continuation notice as a line of the file', () => {
    const page = '3: c\n4: d\n5: e\n6: f\n[Lines 3-6 of 20 shown. Continue with offset: 7.]';
    expect(
      deriveToolPresentation(
        'Read',
        { filePath: 'src/a.ts', offset: 3, limit: 4 },
        result({ output: page }),
      ).summary,
    ).toBe('Read(src/a.ts) · 4 lines 3-6');
    const cut = '1: xxx\n[Line 1 (60000 bytes) was cut to fit one Read (50 KB).]';
    expect(
      deriveToolPresentation('Read', { filePath: 'min.js' }, result({ output: cut })).summary,
    ).toBe('Read(min.js) · 1 line');
  });
});

describe('tool row targets', () => {
  // A call whose arguments were not valid JSON shows its raw text as the target.
  const tab = String.fromCharCode(9);
  const csi = String.fromCharCode(0x9b);
  const controlCharacter = /[\u0000-\u001f\u007f-\u009f]/;

  it('folds control characters out of the target and the summary', () => {
    const presentation = deriveToolPresentation(
      'Bash',
      { __raw: `{"command":"echo one\n${tab}echo${csi}two"}` },
      result({ success: false, error: 'Invalid JSON arguments for Bash' }),
    );

    expect(presentation.target).toBe('{"command":"echo one echo two"}');
    expect(presentation.summary).not.toMatch(controlCharacter);
    expect(composeToolRow(presentation, transcriptGrid(100)).target).not.toMatch(controlCharacter);
  });

  it('shows ordinary spaces in a target verbatim', () => {
    expect(deriveToolPresentation('Grep', { pattern: '^    def ' }).target).toBe('^    def ');
    const commit = deriveToolPresentation('Bash', { command: 'git commit -m "fix  typo"' });
    expect(commit.target).toBe('git commit -m "fix  typo"');
    expect(commit.summary).toContain('git commit -m "fix  typo"');
    expect(deriveToolPresentation('Grep', { pattern: '   ' }).target).toBe('   ');
  });

  it('keeps a long run of spaces as it is, in one linear pass', () => {
    const spaces = ' '.repeat(30_000);
    const presentation = deriveToolPresentation('Bash', {
      __raw: `{"command":"a${spaces}b"}`,
    });

    expect(presentation.target).toBe(`{"command":"a${spaces}b"}`);
  });

  it('shows the raw text of a call marked by the typed unparsedArguments field', () => {
    // Same row as the `{__raw}` sentinel produced, reached through the type the
    // providers set: `arguments` is `{}`, so the target has to come from the
    // field, not the arguments object.
    const raw = `{"command":"echo one\n${tab}echo${csi}two"}`;
    const presentation = deriveToolPresentation(
      'Bash',
      {},
      result({ success: false, error: 'Invalid JSON arguments for Bash' }),
      { unparsedArguments: { raw, error: 'Bad control character' } },
    );

    expect(presentation.target).toBe('{"command":"echo one echo two"}');
    expect(presentation.summary).not.toMatch(controlCharacter);
  });
});

describe('decision tool rows', () => {
  it('names a plan by its title and counts its steps', () => {
    const presentation = deriveToolPresentation('ExitPlanMode', {
      plan: '## Fix the timeout fallback\n\n1. Add a parser.\n2. Route both settings.\n3. Test it.',
    });
    expect(presentation.title).toBe('Plan');
    expect(presentation.target).toBe('Fix the timeout fallback');
    expect(presentation.metadata).toEqual(['3 steps']);
  });

  it('names the questions an ask carries', () => {
    const presentation = deriveToolPresentation('AskUserQuestion', {
      questions: [{ header: 'Fallback' }, { header: 'Scope' }],
    });
    expect(presentation.title).toBe('Ask');
    expect(presentation.target).toBe('Fallback, Scope');
    expect(presentation.metadata).toEqual(['2 questions']);
  });
});

describe('TodoWrite rows', () => {
  const todos = [
    { content: 'Read the loader', status: 'completed' },
    { content: 'Reproduce the bug', status: 'completed' },
    { content: 'Fix the parser', status: 'in_progress', activeForm: 'Fixing the parser' },
    { content: 'Run the suite', status: 'pending' },
  ];

  it('names the step in flight and where the plan stands, without a duration', () => {
    const result = {
      version: 2,
      toolCallId: 'call-1',
      status: 'success',
      content: 'Todos updated (4).',
      metrics: { durationMs: 3 },
    } as ToolResult;
    const presentation = deriveToolPresentation('TodoWrite', { todos }, result);
    expect(presentation.title).toBe('Steps');
    expect(presentation.target).toBe('Fix the parser');
    expect(presentation.metadata).toEqual(['2 of 4 done']);
  });

  it('reads the same off a result the registry enriched', () => {
    const result = enrichToolResultPresentation(
      { ...toolSuccess('Todos updated (4).'), metrics: { durationMs: 3 } },
      'TodoWrite',
      { todos },
    );
    expect(result.presentation).toBeDefined();
    const presentation = deriveToolPresentation('TodoWrite', { todos }, result);
    expect(presentation.title).toBe('Steps');
    expect(presentation.target).toBe('Fix the parser');
    expect(presentation.metadata).toEqual(['2 of 4 done']);
  });

  it('says only that a refused or failed call failed', () => {
    const failed = enrichToolResultPresentation(
      toolFailure('Only one todo may be in_progress at a time (got 2).'),
      'TodoWrite',
      { todos },
    );
    const presentation = deriveToolPresentation('TodoWrite', { todos }, failed);
    expect(presentation.target).toBeUndefined();
    expect(presentation.metadata).toEqual(['failed']);
  });

  it('says the same while the call is still running', () => {
    const presentation = deriveToolPresentation('TodoWrite', { todos });
    expect(presentation.target).toBe('Fix the parser');
    expect(presentation.metadata).toEqual(['2 of 4 done']);
  });

  it('leaves the target empty once no step is in flight', () => {
    const finished = todos.map((todo) => ({ ...todo, status: 'completed' }));
    const presentation = deriveToolPresentation('TodoWrite', { todos: finished });
    expect(presentation.target).toBeUndefined();
    expect(presentation.metadata).toEqual(['4 of 4 done']);
  });

  it('ignores malformed entries', () => {
    const presentation = deriveToolPresentation('TodoWrite', {
      todos: [null, 'x', { content: 'Fix the parser', status: 'in_progress' }],
    });
    expect(presentation.target).toBe('Fix the parser');
    expect(presentation.metadata).toEqual(['0 of 1 done']);
  });
});

describe('exit code metadata', () => {
  const args = { command: 'bash scripts/fail.sh' };
  const failed = (details?: Record<string, unknown>, content = '') =>
    toolFailure('boom', { code: 'tool_error', content, ...(details ? { details } : {}) });

  it('names a non-zero exit code right after the failed marker', () => {
    const withCode = failed({ exitCode: 1 });
    const bare = deriveToolPresentation('Bash', args, withCode);
    expect(bare.metadata).toEqual(['failed', 'exit 1']);

    const enriched = enrichToolResultPresentation(
      { ...withCode, metrics: { durationMs: 7 } },
      'Bash',
      args,
    );
    expect(deriveToolPresentation('Bash', args, enriched).metadata).toEqual([
      'failed',
      'exit 1',
      '7ms',
    ]);
  });

  it('adds nothing when the failure carries no exit code', () => {
    expect(deriveToolPresentation('Bash', args, failed()).metadata).toEqual(['failed']);
    expect(deriveToolPresentation('Bash', args, failed({ exitCode: '1' })).metadata).toEqual([
      'failed',
    ]);
    expect(deriveToolPresentation('Bash', args, failed({ exitCode: 0 })).metadata).toEqual([
      'failed',
    ]);
  });

  it('shows by the presence of the code, not by the tool name', () => {
    const presentation = deriveToolPresentation(
      'SomeShellTool',
      { command: 'make' },
      failed({ exitCode: 2 }),
    );
    expect(presentation.metadata).toEqual(['failed', 'exit 2']);
  });

  it('does not show on a result that succeeded', () => {
    const ok = { ...toolSuccess('fine'), structuredError: undefined };
    expect(deriveToolPresentation('Bash', args, ok).metadata).not.toContain('exit 1');
  });

  it('drops the stdout line count from a failed row that shows its exit code', () => {
    const stdout = Array.from({ length: 12 }, (_, i) => `line ${i + 1}`).join('\n');
    const withCode = deriveToolPresentation('Bash', args, {
      ...failed({ exitCode: 1 }, stdout),
      metrics: { durationMs: 7 },
    });
    expect(withCode.metadata).toEqual(['failed', 'exit 1', '7ms']);
    expect(withCode.metadata.join(' ')).not.toMatch(/lines?/);
    // A failure without a code keeps the size, and a success is unchanged.
    expect(deriveToolPresentation('Bash', args, failed(undefined, stdout)).metadata).toEqual([
      'failed',
      '12 lines',
    ]);
    expect(deriveToolPresentation('Bash', args, toolSuccess(stdout)).metadata).toEqual([
      '12 lines',
    ]);
  });
});

describe('exit code metadata of a BashOutput read', () => {
  const args = { shell_id: 'shell-1' };
  const read = (shell: Record<string, unknown>, output = 'a\nb\nc') =>
    result({ output, data: { shell: { id: 'shell-1', ...shell }, output: 'a', remaining: 0 } });

  it('names the non-zero exit code of a shell that finished, leaving the row a success', () => {
    for (const status of ['exited', 'failed', 'killed', 'timed_out', 'lost']) {
      const presentation = deriveToolPresentation(
        'BashOutput',
        args,
        read({ status, exitCode: 2 }),
      );
      expect(presentation.metadata).toContain('exit 2');
      expect(presentation.metadata).not.toContain('failed');
      expect(presentation.status).toBe('success');
    }
  });

  it('names the code on a result the registry enriched, ahead of the duration', () => {
    const enriched = enrichToolResultPresentation(
      { ...read({ status: 'exited', exitCode: 2 }), metrics: { durationMs: 7 } },
      'BashOutput',
      args,
    );
    expect(deriveToolPresentation('BashOutput', args, enriched).metadata).toEqual([
      'exit 2',
      '7ms',
    ]);
  });

  it('adds nothing for a shell still running, or a clean exit', () => {
    for (const shell of [
      { status: 'running', exitCode: 2 },
      { status: 'running' },
      { status: 'starting', exitCode: null },
      { status: 'exited', exitCode: 0 },
      { status: 'exited', exitCode: null },
      { status: 'exited' },
      { status: 'exited', exitCode: '2' },
    ]) {
      const { metadata } = deriveToolPresentation('BashOutput', args, read(shell));
      expect(metadata.join(' ')).not.toMatch(/exit/);
    }
  });

  it('adds nothing when the result carries no shell record', () => {
    for (const data of [undefined, null, 'x', {}, { shell: null }, { shell: 'x' }]) {
      const { metadata } = deriveToolPresentation(
        'BashOutput',
        args,
        result({ output: 'a', data }),
      );
      expect(metadata.join(' ')).not.toMatch(/exit/);
    }
  });

  it('is only for BashOutput', () => {
    const { metadata } = deriveToolPresentation(
      'Bash',
      { command: 'x' },
      read({ status: 'exited', exitCode: 2 }),
    );
    expect(metadata.join(' ')).not.toMatch(/exit/);
  });
});

describe('composeToolRow meta width of a failed row', () => {
  const grid = transcriptGrid(100);

  it('widens the meta column for a BashOutput row that names its exit code', () => {
    const row = composeToolRow(
      { title: 'Shell output', target: 'shell-1', metadata: ['exit 255', '12 lines', '1m 12s'] },
      grid,
    );
    expect(row.meta).toBe('exit 255 · 12 lines · 1m 12s');
  });

  it('widens the meta column for a row that names its exit code', () => {
    const row = composeToolRow(
      { title: 'Bash', target: 'npm test', metadata: ['failed', 'exit 255', '1m 12s'] },
      grid,
    );
    expect(row.meta).toBe('failed · exit 255 · 1m 12s');
    expect(displayWidth(row.meta)).toBeGreaterThan(grid.meta);
  });

  it('keeps the default meta width for a failed row without an exit code', () => {
    const row = composeToolRow(
      { title: 'Bash', target: 'npm test', metadata: ['failed', 'attempt 3', '1m 12s elapsed'] },
      grid,
    );
    expect(displayWidth(row.meta)).toBeLessThanOrEqual(grid.meta);
    expect(row.meta.endsWith('…')).toBe(true);
  });
});

describe('composeToolRow meta growth into free target columns', () => {
  const WIDTHS = [120, 80, 60, 40, 25, 20];
  const GROW = { metaMayGrow: true };
  const THREE = ['1 file', '1 search', '1 listing'];
  const FOUR = ['1 file', '1 search', '1 listing', '2 lookups'];
  const FOUR_TEXT = '1 file · 1 search · 1 listing · 2 lookups';
  const LONG_TARGET = `${'src/some/very/long/directory/structure/that/keeps/going/'.repeat(3)}file.ts`;
  const LONG_META = ['12 files', '8 searches', '3 listings', '14 git reads'];

  function line(row: ReturnType<typeof composeToolRow>): string {
    return `${row.label}${row.label ? ' ' : ''}${row.target}${row.gap}${row.meta}`;
  }

  /** The row's display width as the TUI draws it: the label column and its space, then the rest. */
  function rowWidth(row: ReturnType<typeof composeToolRow>, grid: { label: number }): number {
    return (row.label ? grid.label + 1 : 0) + displayWidth(`${row.target}${row.gap}${row.meta}`);
  }

  it('shows three metadata parts uncut on a short target at 120 columns', () => {
    const grid = transcriptGrid(120);
    const row = composeToolRow({ title: 'Read', target: 'a.js', metadata: THREE }, grid, GROW);
    expect(row.meta).toBe('1 file · 1 search · 1 listing');
    expect(displayWidth(row.meta)).toBeGreaterThan(grid.meta);
  });

  for (const width of [120, 80, 60]) {
    it(`shows four metadata parts uncut on a short target at ${width} columns`, () => {
      const row = composeToolRow(
        { title: 'Read', target: 'a.js', metadata: FOUR },
        transcriptGrid(width),
        GROW,
      );
      expect(row.meta).toBe(FOUR_TEXT);
    });
  }

  it('does not grow the metadata unless the caller opts in', () => {
    const grid = transcriptGrid(120);
    const row = composeToolRow({ title: 'Read', target: 'a.js', metadata: THREE }, grid);
    expect(displayWidth(row.meta)).toBe(grid.meta);
    expect(row.meta.endsWith('…')).toBe(true);
  });

  it('renders a running row with an elapsed time as before: the meta is cut at the column', () => {
    const grid = transcriptGrid(120);
    const row = composeToolRow(
      { title: 'Bash', target: 'npm test', metadata: ['12 lines', '3 matches'] },
      grid,
      { elapsed: '1m 12s elapsed' },
    );
    expect(grid.meta).toBe(20);
    expect(row.meta).toBe('12 lines · 3 matche…');
    expect(rowWidth(row, grid)).toBe(grid.row);
  });

  it('keeps the fixed budget and truncates the target first when the target is long', () => {
    const grid = transcriptGrid(120);
    const row = composeToolRow(
      { title: 'Read', target: LONG_TARGET, metadata: LONG_META },
      grid,
      GROW,
    );
    expect(displayWidth(row.meta)).toBe(grid.meta);
    expect(row.meta.endsWith('…')).toBe(true);
    expect(row.target.endsWith('…')).toBe(true);
    expect(displayWidth(row.target)).toBe(grid.row - (grid.label + 1) - grid.meta - 1);
  });

  it('renders metadata that fits the meta column exactly as before', () => {
    const grid = transcriptGrid(120);
    const row = composeToolRow({ title: 'Read', target: 'a.js', metadata: ['1 file'] }, grid, GROW);
    // label column, target, padding to the measure, then the metadata flush right
    const padding = ' '.repeat(grid.row - (grid.label + 1) - 'a.js'.length - '1 file'.length);
    expect(line(row)).toBe(`${'Read'.padEnd(grid.label)} a.js${padding}1 file`);
    // A long-target row ends on the same column.
    const sibling = composeToolRow(
      { title: 'Read', target: LONG_TARGET, metadata: ['1 file'] },
      grid,
      GROW,
    );
    expect(rowWidth(sibling, grid)).toBe(rowWidth(row, grid));
  });

  it('keeps the exit-code budget for a long target', () => {
    const grid = transcriptGrid(120);
    const row = composeToolRow(
      {
        title: 'Bash',
        target: LONG_TARGET,
        metadata: ['failed', 'exit 255', '1m 12s', 'attempt 3', 'a very long item'],
      },
      grid,
    );
    expect(displayWidth(row.meta)).toBe(28);
    expect(row.meta.endsWith('…')).toBe(true);
  });

  const cases: Array<[string, string, string[]]> = [
    ['three parts', 'a.js', THREE],
    ['four parts', 'a.js', FOUR],
    ['long target, long metadata', LONG_TARGET, LONG_META],
    ['fitting metadata', 'a.js', ['1 file']],
    ['exit code, long target', LONG_TARGET, ['failed', 'exit 255', '1m 12s', 'attempt 3']],
    ['exit code, short target', 'npm test', ['failed', 'exit 255', '1m 12s']],
    ['no metadata', 'a.js', []],
  ];

  for (const width of WIDTHS) {
    for (const [name, target, metadata] of cases) {
      for (const grow of [false, true]) {
        it(`fills the measure on one line at ${width} columns: ${name}${grow ? ' (growing)' : ''}`, () => {
          const grid = transcriptGrid(width);
          const row = composeToolRow({ title: 'Read', target, metadata }, grid, {
            metaMayGrow: grow,
          });
          for (const column of [row.label, row.target, row.gap, row.meta]) {
            expect(column).not.toMatch(/[\r\n]/);
          }
          expect(rowWidth(row, grid)).toBe(grid.row);
        });
      }
    }
  }
});

describe('TodoWrite row mark', () => {
  const todos = [
    { content: 'Clone the repo', status: 'in_progress' },
    { content: 'Install', status: 'pending' },
  ];

  it('marks the plan under way on a result the registry enriched', () => {
    const result = enrichToolResultPresentation(toolSuccess('Todos updated (2).'), 'TodoWrite', {
      todos,
    });
    expect(result.presentation).toBeDefined();
    expect(deriveToolPresentation('TodoWrite', { todos }, result).mark).toBe('◔');
  });

  it('carries no mark while the call runs or after it failed', () => {
    expect(deriveToolPresentation('TodoWrite', { todos }).mark).toBeUndefined();
    const failed = enrichToolResultPresentation(toolFailure('bad plan'), 'TodoWrite', { todos });
    expect(deriveToolPresentation('TodoWrite', { todos }, failed).mark).toBeUndefined();
  });

  it('is only for TodoWrite', () => {
    const result = enrichToolResultPresentation(toolSuccess('ok'), 'Bash', { command: 'ls' });
    expect(deriveToolPresentation('Bash', { command: 'ls' }, result).mark).toBeUndefined();
  });
});

describe('calls refused before they ran', () => {
  it.each([
    ['unknown_tool', undefined],
    ['invalid_json_arguments', undefined],
    ['invalid_arguments', { preExecution: true }],
  ])('reads %s as a rejection', (code, details) => {
    const failed = enrichToolResultPresentation(
      toolFailure('Invalid arguments for TodoWrite: arguments.todos is required.', {
        code,
        details,
      }),
      'TodoWrite',
      {},
    );
    const presentation = deriveToolPresentation('TodoWrite', {}, failed);
    expect(presentation.status).toBe('failure');
    expect(presentation.rejected).toBe(true);
  });

  it('keeps an argument refusal from a tool that ran a failure', () => {
    // `Read {outline: true, offset}` reads the file, then refuses the pair with
    // `invalid_arguments` and no pre-execution flag: the tool did run.
    const failed = enrichToolResultPresentation(
      toolFailure('outline and offset cannot be combined', { code: 'invalid_arguments' }),
      'Read',
      { filePath: 'a.ts', outline: true, offset: 10 },
    );
    const presentation = deriveToolPresentation(
      'Read',
      { filePath: 'a.ts', outline: true, offset: 10 },
      failed,
    );
    expect(presentation.rejected).toBe(false);
  });

  it('keeps a call that ran and failed a failure', () => {
    // A test run that exits 1 is the transcript's only record of a red suite.
    const failed = enrichToolResultPresentation(
      toolFailure('Exit code: 1', { code: 'command_failed' }),
      'Bash',
      { command: 'npm test' },
    );
    expect(deriveToolPresentation('Bash', { command: 'npm test' }, failed).rejected).toBe(false);
  });

  it('leaves refusals to the skipped row', () => {
    const blocked = toolFailure('Tool "WebFetch" is not active for this turn.', {
      code: 'tool_not_active',
      status: 'blocked',
    });
    const presentation = deriveToolPresentation('WebFetch', { url: 'https://a.test' }, blocked);
    expect(presentation.status).toBe('skipped');
    expect(presentation.rejected).toBe(false);
  });
});
