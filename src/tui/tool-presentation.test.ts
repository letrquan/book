import { describe, expect, it } from 'vitest';
import type { ToolResult } from '../types.js';
import {
  deriveToolPresentation,
  getTranscriptShortcutAction,
  groupConsecutiveMcpCalls,
  parseMcpToolName,
  shouldExpandTool,
} from './tool-presentation.js';

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
    expect(create.showArguments).toBe(false);

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
    ).toBe('Update(src/a.ts) · +1 -1');
  });

  it('derives legacy diffstats without changing persisted tool results', () => {
    expect(
      deriveToolPresentation(
        'edit_file',
        { file_path: 'src/legacy.ts' },
        result({ output: '@@ -1 +1,2 @@\n-old\n+new\n+extra' }),
      ).summary,
    ).toBe('Update(src/legacy.ts) · +2 -1');
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
    ).toBe('Bash(npm test) · 1 line, 6 B 1.3s');
    expect(deriveToolPresentation('Bash', { command: 'npm test' }).showArguments).toBe(true);
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

  it('does not mark an argument-suppressed mutation error as expandable', () => {
    const presentation = deriveToolPresentation(
      'Edit',
      { filePath: 'src/a.ts', oldString: 'old', newString: 'new' },
      result({ success: false, error: 'old string not found' }),
    );
    expect(presentation.showArguments).toBe(false);
    expect(presentation.hasHiddenContent).toBe(false);
  });
});

describe('MCP compact grouping', () => {
  it('parses MCP names and groups only adjacent successful calls from one server', () => {
    expect(parseMcpToolName('mcp__team_slack__search_messages')).toEqual({
      server: 'team_slack',
      tool: 'search messages',
    });
    const calls = [
      { id: '1', name: 'mcp__slack__search', call: 1, result: result() },
      { id: '2', name: 'mcp__slack__post', call: 2, result: result() },
      { id: '3', name: 'mcp__github__issue', call: 3, result: result() },
      {
        id: '4',
        name: 'mcp__github__comment',
        call: 4,
        result: result({ success: false, error: 'denied' }),
      },
    ];

    const groups = groupConsecutiveMcpCalls(calls);
    expect(groups).toHaveLength(3);
    expect(groups[0]).toMatchObject({ kind: 'mcp-group', server: 'slack' });
    expect(groups[1]).toMatchObject({ kind: 'tool', invocation: { id: '3' } });
    expect(groups[2]).toMatchObject({ kind: 'tool', invocation: { id: '4' } });
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
        expansionOverrides: overrides,
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
