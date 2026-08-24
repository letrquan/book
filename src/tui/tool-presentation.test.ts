import { describe, expect, it } from 'vitest';
import type { ToolResult } from '../types/tools.js';
import {
  deriveToolPresentation,
  getTranscriptShortcutAction,
  parseMcpToolName,
  shouldExpandTool,
} from './tool-presentation.js';
import { composeToolRow } from './tool-presentation.js';
import { transcriptGrid } from './layout.js';
import { displayWidth } from './components/word-wrap.js';

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

describe('composeToolRow', () => {
  const grid = transcriptGrid(100);

  function render(row: ReturnType<typeof composeToolRow>): string {
    return `${row.label}${row.label ? ' ' : ''}${row.target}${row.gap}${row.meta}`;
  }

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

  it('replaces metadata with the error message on a failure', () => {
    const row = composeToolRow({ title: 'Bash', target: 'npm test', metadata: ['failed'] }, grid, {
      error: 'exit code 1',
    });
    expect(row.meta).toBe('exit code 1');
    expect(row.meta).not.toContain('failed');
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

describe('composeToolRow error budget', () => {
  it('gives a failure message room the target would otherwise take', () => {
    const grid = transcriptGrid(100);
    const row = composeToolRow(
      {
        title: 'Bash',
        target: 'npx vitest run --config vitest.unit.config.ts src/tui/persist.test.ts',
        metadata: ['failed'],
      },
      grid,
      { error: 'command failed with exit code 1' },
    );
    expect(row.meta).toBe('command failed with exit code 1');
    expect(displayWidth(`${row.label} ${row.target}${row.gap}${row.meta}`)).toBeLessThanOrEqual(
      grid.content,
    );
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
    const row = composeToolRow({ title: 'Bash', target: 'x'.repeat(200), metadata: [] }, grid, {
      error: 'exit 1',
    });
    expect(row.label).toBe('');
    expect(displayWidth(`${row.target}${row.gap}${row.meta}`)).toBe(grid.content);
    // One column of gap before the metadata, and no run of padding beyond it.
    expect(row.gap).toBe(' ');
  });
});
