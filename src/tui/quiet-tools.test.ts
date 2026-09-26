import { describe, expect, it } from 'vitest';
import type { Message } from '../types/messages.js';
import type { ToolCall, ToolResult } from '../types/tools.js';
import {
  createQuietCollapser,
  groupQuietInvocations,
  hasVisibleText,
  isQuietInvocation,
  continuesQuietRun,
  summarizeQuietRun,
  type QuietToolContext,
} from './quiet-tools.js';

const NONE: QuietToolContext = { pinned: new Set() };

function call(id: string, name: string, args: Record<string, unknown> = {}): ToolCall {
  return { id, name, arguments: args };
}

function ok(toolCallId: string): ToolResult {
  return { version: 2, toolCallId, status: 'success', content: 'ok' };
}

function failed(toolCallId: string): ToolResult {
  return { version: 2, toolCallId, status: 'error', content: '' };
}

function assistant(
  id: string,
  content: string,
  calls: ToolCall[],
  results: ToolResult[] = calls.map((c) => ok(c.id)),
): Message {
  return {
    id,
    role: 'assistant',
    content,
    includeInContext: true,
    timestamp: 1,
    toolCalls: calls,
    toolResults: results,
  };
}

describe('isQuietInvocation', () => {
  const message = assistant('m', '', []);

  it('folds successful and running reads, searches and lookups', () => {
    expect(isQuietInvocation(call('a', 'Read'), ok('a'), message, NONE)).toBe(true);
    expect(isQuietInvocation(call('b', 'Grep'), ok('b'), message, NONE)).toBe(true);
    expect(isQuietInvocation(call('c', 'GitStatus'), ok('c'), message, NONE)).toBe(true);
    // A running read joins the run; the summary carries the spinner.
    expect(isQuietInvocation(call('d', 'Read'), undefined, message, NONE)).toBe(true);
  });

  it('keeps changes, commands, the network and delegation on their own rows', () => {
    for (const name of ['Edit', 'Write', 'ApplyPatch', 'Bash', 'WebFetch', 'AgentSpawn', 'Task']) {
      expect(isQuietInvocation(call('x', name), ok('x'), message, NONE)).toBe(false);
    }
  });

  it('keeps a failure, a pending prompt and a pinned row visible', () => {
    expect(isQuietInvocation(call('a', 'Read'), failed('a'), message, NONE)).toBe(false);
    expect(
      isQuietInvocation(call('a', 'Read'), undefined, message, { ...NONE, pendingToolId: 'a' }),
    ).toBe(false);
    expect(isQuietInvocation(call('a', 'Read'), ok('a'), message, { pinned: new Set(['a']) })).toBe(
      false,
    );
  });
});

describe('hasVisibleText', () => {
  it('ignores the empty think block routers put on every tool turn', () => {
    expect(hasVisibleText(assistant('m', '<think></think>', []), true)).toBe(false);
    expect(hasVisibleText(assistant('m', '  \n', []), true)).toBe(false);
  });

  it('counts prose, and reasoning only when thinking is shown', () => {
    expect(hasVisibleText(assistant('m', 'Reading the loader.', []), false)).toBe(true);
    const reasoning = assistant('m', '<think>check the loader</think>', []);
    expect(hasVisibleText(reasoning, true)).toBe(true);
    expect(hasVisibleText(reasoning, false)).toBe(false);
  });
});

describe('continuesQuietRun', () => {
  it('needs a quiet first call and no text of its own', () => {
    expect(continuesQuietRun(assistant('m', '', [call('a', 'Read')]), NONE, true)).toBe(true);
    expect(
      continuesQuietRun(assistant('m', '<think></think>', [call('a', 'Read')]), NONE, true),
    ).toBe(true);
    // The turn that ends a run often carries the edit that follows it.
    expect(
      continuesQuietRun(assistant('m', '', [call('a', 'Read'), call('b', 'Edit')]), NONE, true),
    ).toBe(true);
    expect(
      continuesQuietRun(assistant('m', 'Now the tests.', [call('a', 'Read')]), NONE, true),
    ).toBe(false);
    expect(continuesQuietRun(assistant('m', '', [call('b', 'Edit')]), NONE, true)).toBe(false);
    expect(continuesQuietRun(assistant('m', 'Done.', []), NONE, true)).toBe(false);
  });
});

describe('createQuietCollapser', () => {
  it('folds a run of one-read turns into the entry that started it', () => {
    const collapse = createQuietCollapser();
    const first = assistant('a1', 'I will read the loader.', [call('r1', 'Read')]);
    const second = assistant('a2', '<think></think>', [call('r2', 'Read')]);
    const third = assistant('a3', '', [call('r3', 'Grep')]);
    const edit = assistant('a4', '', [call('e1', 'Edit')]);
    const { entries, sourceIds } = collapse([first, second, third, edit], NONE, true);

    expect(entries.map((entry) => entry.id)).toEqual(['a1', 'a4']);
    expect(entries[0]!.content).toBe('I will read the loader.');
    expect(entries[0]!.toolCalls!.map((c) => c.id)).toEqual(['r1', 'r2', 'r3']);
    expect(entries[0]!.toolResults!.map((r) => r.toolCallId)).toEqual(['r1', 'r2', 'r3']);
    expect(sourceIds.get('a1')).toEqual(['a1', 'a2', 'a3']);
  });

  it('carries the edit that ends a run along with its last read', () => {
    const collapse = createQuietCollapser();
    const first = assistant('a1', 'Reading.', [call('r1', 'Read')]);
    const last = assistant('a2', '', [call('r2', 'Read'), call('e1', 'Edit')]);
    const { entries } = collapse([first, last], NONE, true);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.toolCalls!.map((c) => c.id)).toEqual(['r1', 'r2', 'e1']);
    // Drawn as one summary for the reads, then the edit on its own row.
    const invocations = entries[0]!.toolCalls!.map((c) => ({
      call: c,
      result: entries[0]!.toolResults!.find((r) => r.toolCallId === c.id),
    }));
    expect(groupQuietInvocations(invocations, entries[0]!, NONE)).toEqual([
      { kind: 'quiet', indices: [0, 1] },
      { kind: 'single', index: 2 },
    ]);
  });

  it('does not fold into an entry whose last call changed something', () => {
    const collapse = createQuietCollapser();
    const edit = assistant('a1', '', [call('e1', 'Edit')]);
    const read = assistant('a2', '', [call('r1', 'Read')]);
    expect(collapse([edit, read], NONE, true).entries).toHaveLength(2);
  });

  it('never folds across a user turn', () => {
    const collapse = createQuietCollapser();
    const read = assistant('a1', '', [call('r1', 'Read')]);
    const user: Message = {
      id: 'u1',
      role: 'user',
      content: 'go on',
      includeInContext: true,
      timestamp: 1,
    };
    const next = assistant('a2', '', [call('r2', 'Read')]);
    expect(collapse([read, user, next], NONE, true).entries).toHaveLength(3);
  });

  it('keeps the merged object for a run that did not change', () => {
    const collapse = createQuietCollapser();
    const first = assistant('a1', '', [call('r1', 'Read')]);
    const second = assistant('a2', '', [call('r2', 'Read')]);
    const once = collapse([first, second], NONE, true).entries[0];
    const twice = collapse([first, second], NONE, true).entries[0];
    expect(twice).toBe(once);
    const grown = collapse([first, second, assistant('a3', '', [call('r3', 'Read')])], NONE, true)
      .entries[0];
    expect(grown).not.toBe(once);
  });
});

describe('groupQuietInvocations', () => {
  const message = assistant('m', '', []);
  const inv = (id: string, name: string, result: ToolResult | undefined = ok(id)) => ({
    call: call(id, name),
    result,
  });

  it('folds runs of two or more and leaves a lone quiet call as a row', () => {
    const rows = groupQuietInvocations(
      [inv('a', 'Read'), inv('b', 'Grep'), inv('c', 'Edit'), inv('d', 'Read')],
      message,
      NONE,
    );
    expect(rows).toEqual([
      { kind: 'quiet', indices: [0, 1] },
      { kind: 'single', index: 2 },
      { kind: 'single', index: 3 },
    ]);
  });
});

describe('summarizeQuietRun', () => {
  it('names the files read and counts files and searches', () => {
    const summary = summarizeQuietRun([
      { call: call('a', 'Read', { file_path: 'src/config.ts' }), result: ok('a') },
      { call: call('b', 'Read', { file_path: 'src/config.ts' }), result: ok('b') },
      { call: call('c', 'Read', { file_path: 'C:\\repo\\src\\loader.ts' }), result: ok('c') },
      { call: call('d', 'Grep', { pattern: 'timeoutMs' }), result: ok('d') },
    ]);
    expect(summary).toEqual({
      title: 'Read',
      target: 'config.ts, loader.ts',
      metadata: ['2 files', '1 search'],
      running: false,
    });
  });

  it('titles a search-only run by its patterns and marks a run with a live call', () => {
    const summary = summarizeQuietRun([
      { call: call('a', 'Grep', { pattern: 'retries' }), result: ok('a') },
      { call: call('b', 'Glob', { pattern: '**/*.ts' }) },
    ]);
    expect(summary.title).toBe('Search');
    expect(summary.target).toBe('retries, **/*.ts');
    expect(summary.metadata).toEqual(['2 searches']);
    expect(summary.running).toBe(true);
  });
});

describe('continuesQuietRun and delegation', () => {
  it('never joins a turn that spawns an agent', () => {
    const turn = assistant('m', '', [call('a', 'Read'), call('s', 'AgentSpawn')]);
    expect(continuesQuietRun(turn, NONE, true)).toBe(false);
  });
});

describe('reads outside the workspace', () => {
  const message = assistant('m', '', []);
  const context: QuietToolContext = { pinned: new Set(), workspace: '/repo' };

  it('keeps a read that leaves the workspace on its own row', () => {
    const outside = call('a', 'Read', { file_path: '/etc/hosts' });
    const parent = call('b', 'Read', { file_path: '../secrets.env' });
    const inside = call('c', 'Read', { file_path: 'src/config.ts' });
    const absoluteInside = call('d', 'Grep', { pattern: 'x', path: '/repo/src' });
    expect(isQuietInvocation(outside, ok('a'), message, context)).toBe(false);
    expect(isQuietInvocation(parent, ok('b'), message, context)).toBe(false);
    expect(isQuietInvocation(inside, ok('c'), message, context)).toBe(true);
    expect(isQuietInvocation(absoluteInside, ok('d'), message, context)).toBe(true);
  });
});
