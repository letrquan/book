import { describe, expect, it } from 'vitest';
import type { ToolResult } from '../types/tools.js';
import {
  deriveToolPresentation,
  getTranscriptShortcutAction,
  isShortcutsToggleKey,
  parseMcpToolName,
  shouldExpandTool,
} from './tool-presentation.js';
import { composeToolErrorDetail, composeToolRow, planMark } from './tool-presentation.js';
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
