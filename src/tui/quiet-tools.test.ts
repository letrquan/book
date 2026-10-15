import { describe, expect, it } from 'vitest';
import type { Message } from '../types/messages.js';
import type { ToolCall, ToolResult } from '../types/tools.js';
import {
  createQuietCollapser,
  groupQuietInvocations,
  allCallsQuiet,
  hasProse,
  hasReasoning,
  createShellPartsMemo,
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

/** A one-call turn that reasons first, as an inline `<think>` part or native reasoning. */
function reasonedRead(
  id: string,
  toolCall: ToolCall,
  how: 'think' | 'native',
  extra = '',
): Message {
  return {
    ...assistant(id, how === 'think' ? `<think>weighing ${id}</think>${extra}` : extra, [toolCall]),
    ...(how === 'native' ? { reasoningContent: `weighing ${id}` } : {}),
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

describe('hasProse', () => {
  it('counts markdown only, never reasoning', () => {
    expect(hasProse(assistant('m', 'Reading the loader.', []))).toBe(true);
    expect(hasProse(assistant('m', '<think>check the loader</think>', []))).toBe(false);
    expect(hasProse(assistant('m', '<think></think>', []))).toBe(false);
    expect(hasProse({ ...assistant('m', '', []), reasoningContent: 'check' })).toBe(false);
    expect(hasProse(assistant('m', '<think>x</think>Then this.', []))).toBe(true);
  });
});

describe('hasReasoning', () => {
  it('counts a non-blank think part or native reasoning, not an empty block', () => {
    expect(hasReasoning(assistant('m', '<think>check the loader</think>', []))).toBe(true);
    expect(hasReasoning({ ...assistant('m', '', []), reasoningContent: 'check' })).toBe(true);
    expect(hasReasoning(assistant('m', '<think></think>', []))).toBe(false);
    expect(hasReasoning({ ...assistant('m', '', []), reasoningContent: '  \n' })).toBe(false);
    expect(hasReasoning(assistant('m', 'Reading the loader.', []))).toBe(false);
  });
});

describe('allCallsQuiet', () => {
  it('needs a call, and every call quiet', () => {
    expect(allCallsQuiet(assistant('m', '', []), NONE)).toBe(false);
    expect(allCallsQuiet(assistant('m', '', [call('a', 'Read'), call('b', 'Grep')]), NONE)).toBe(
      true,
    );
    for (const name of ['Edit', 'Bash', 'AgentSpawn']) {
      expect(allCallsQuiet(assistant('m', '', [call('a', 'Read'), call('b', name)]), NONE)).toBe(
        false,
      );
    }
  });

  it('is false for a pending, failed, pinned or outside-the-workspace call', () => {
    const turn = assistant('m', '', [call('a', 'Read'), call('b', 'Read')]);
    expect(allCallsQuiet(turn, { ...NONE, pendingToolId: 'b' })).toBe(false);
    expect(allCallsQuiet(turn, { pinned: new Set(['a']) })).toBe(false);
    const failedTurn = assistant('m', '', [call('a', 'Read')], [failed('a')]);
    expect(allCallsQuiet(failedTurn, NONE)).toBe(false);
    const outside = assistant('m', '', [call('a', 'Read', { file_path: '/etc/hosts' })]);
    expect(allCallsQuiet(outside, { pinned: new Set(), workspace: '/repo' })).toBe(false);
  });
});

describe('continuesQuietRun', () => {
  it('needs a quiet first call and no text of its own', () => {
    expect(continuesQuietRun(assistant('m', '', [call('a', 'Read')]), NONE)).toBe(true);
    expect(continuesQuietRun(assistant('m', '<think></think>', [call('a', 'Read')]), NONE)).toBe(
      true,
    );
    // The turn that ends a run often carries the edit that follows it.
    expect(
      continuesQuietRun(assistant('m', '', [call('a', 'Read'), call('b', 'Edit')]), NONE),
    ).toBe(true);
    expect(continuesQuietRun(assistant('m', 'Now the tests.', [call('a', 'Read')]), NONE)).toBe(
      false,
    );
    expect(continuesQuietRun(assistant('m', '', [call('b', 'Edit')]), NONE)).toBe(false);
    expect(continuesQuietRun(assistant('m', 'Done.', []), NONE)).toBe(false);
  });

  it('lets a message that reasons continue a run only when every call is quiet', () => {
    const thought = '<think>weighing it</think>';
    expect(continuesQuietRun(assistant('m', thought, [call('a', 'Read')]), NONE)).toBe(true);
    expect(
      continuesQuietRun(assistant('m', thought, [call('a', 'Read'), call('b', 'Read')]), NONE),
    ).toBe(true);
    expect(
      continuesQuietRun(assistant('m', thought, [call('a', 'Read'), call('b', 'Bash')]), NONE),
    ).toBe(false);
    expect(
      continuesQuietRun(assistant('m', thought, [call('a', 'Read'), call('b', 'Edit')]), NONE),
    ).toBe(false);
    const native = { ...assistant('m', '', [call('a', 'Read'), call('b', 'Edit')]) };
    expect(continuesQuietRun({ ...native, reasoningContent: 'weighing it' }, NONE)).toBe(false);
    expect(
      continuesQuietRun(assistant('m', thought, [call('a', 'Read')]), {
        ...NONE,
        pendingToolId: 'a',
      }),
    ).toBe(false);
    expect(
      continuesQuietRun(assistant('m', `${thought}Now the tests.`, [call('a', 'Read')]), NONE),
    ).toBe(false);
  });
});

describe('createQuietCollapser', () => {
  it('folds a run of one-read turns into the entry that started it', () => {
    const collapse = createQuietCollapser();
    const first = assistant('a1', 'I will read the loader.', [call('r1', 'Read')]);
    const second = assistant('a2', '<think></think>', [call('r2', 'Read')]);
    const third = assistant('a3', '', [call('r3', 'Grep')]);
    const edit = assistant('a4', '', [call('e1', 'Edit')]);
    const { entries, sourceIds } = collapse([first, second, third, edit], NONE);

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
    const { entries } = collapse([first, last], NONE);
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
    expect(collapse([edit, read], NONE).entries).toHaveLength(2);
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
    expect(collapse([read, user, next], NONE).entries).toHaveLength(3);
  });

  it('keeps the merged object for a run that did not change', () => {
    const collapse = createQuietCollapser();
    const first = assistant('a1', '', [call('r1', 'Read')]);
    const second = assistant('a2', '', [call('r2', 'Read')]);
    const once = collapse([first, second], NONE).entries[0];
    const twice = collapse([first, second], NONE).entries[0];
    expect(twice).toBe(once);
    const grown = collapse([first, second, assistant('a3', '', [call('r3', 'Read')])], NONE)
      .entries[0];
    expect(grown).not.toBe(once);
  });

  it('keeps the merged object and its absorbed membership for a reasoned run that did not change', () => {
    const collapse = createQuietCollapser();
    const first = reasonedRead('a1', call('r1', 'Read'), 'think');
    const second = reasonedRead('a2', call('r2', 'Read'), 'think');
    const once = collapse([first, second], NONE);
    const twice = collapse([first, second], NONE);
    expect(twice.entries[0]).toBe(once.entries[0]);
    expect(once.absorbedThoughts.has('a1')).toBe(true);
    expect(twice.absorbedThoughts.has('a1')).toBe(true);
  });

  it('rebuilds the merged entry when the head stops being absorbed', () => {
    const collapse = createQuietCollapser();
    const first = reasonedRead('a1', call('r1', 'Read'), 'native');
    const second = reasonedRead('a2', call('r2', 'Read'), 'native');
    const settled = collapse([first, second], NONE);
    expect(settled.entries[0]!.reasoningContent).toBe('weighing a1\n\nweighing a2');
    // A prompt now waits on the head's read: its thought must show.
    const waiting = collapse([first, second], { ...NONE, pendingToolId: 'r1' });
    expect(waiting.entries[0]!.reasoningContent).toBe('weighing a1');
    expect(waiting.absorbedThoughts.has('a1')).toBe(false);
  });
});

describe('reasoning inside a quiet run (#455)', () => {
  const reasoned = reasonedRead;

  it.each(['think', 'native'] as const)(
    'keeps one run whole when each call follows %s reasoning',
    (how) => {
      const collapse = createQuietCollapser();
      const messages = [
        reasoned('a1', call('r1', 'Read', { file_path: 'a.js' }), how),
        reasoned('a2', call('r2', 'Read', { file_path: 'b.js' }), how),
        reasoned('a3', call('r3', 'Read', { file_path: 'c.js' }), how),
        reasoned('a4', call('g1', 'Grep', { pattern: 'TODO' }), how),
      ];
      const { entries, sourceIds, absorbedThoughts } = collapse(messages, NONE);
      expect(entries.map((entry) => entry.id)).toEqual(['a1']);
      expect(entries[0]!.toolCalls!.map((c) => c.id)).toEqual(['r1', 'r2', 'r3', 'g1']);
      expect(sourceIds.get('a1')).toEqual(['a1', 'a2', 'a3', 'a4']);
      expect(absorbedThoughts.has('a1')).toBe(true);
      if (how === 'native') {
        // Other consumers still get every thought, concatenated as before.
        expect(entries[0]!.reasoningContent).toBe(
          'weighing a1\n\nweighing a2\n\nweighing a3\n\nweighing a4',
        );
      }
    },
  );

  it('joins one run whatever form each thought takes', () => {
    const collapse = createQuietCollapser();
    const messages = [
      reasoned('a1', call('r1', 'Read'), 'think'),
      reasoned('a2', call('r2', 'Read'), 'native'),
    ];
    const { entries, absorbedThoughts } = collapse(messages, NONE);
    expect(entries).toHaveLength(1);
    expect(absorbedThoughts.has('a1')).toBe(true);
  });

  it('still starts a new entry for a message with markdown prose', () => {
    const collapse = createQuietCollapser();
    const messages = [
      reasoned('a1', call('r1', 'Read'), 'think'),
      reasoned('a2', call('r2', 'Read'), 'think', 'Now the config.'),
    ];
    expect(collapse(messages, NONE).entries.map((entry) => entry.id)).toEqual(['a1', 'a2']);
  });

  it('keeps the thought of a head that speaks, and carries only the head reasoning', () => {
    const collapse = createQuietCollapser();
    const head: Message = {
      ...assistant('a1', '<think>why these files</think>Let me look around.', [
        call('r1', 'Read', { file_path: 'a.js' }),
      ]),
      reasoningContent: 'why these files',
    };
    const next: Message = {
      ...assistant('a2', '', [call('r2', 'Read', { file_path: 'b.js' })]),
      reasoningContent: 'then this one',
    };
    const { entries, absorbedThoughts } = collapse([head, next], NONE);
    expect(entries.map((entry) => entry.id)).toEqual(['a1']);
    expect(entries[0]!.toolCalls!.map((c) => c.id)).toEqual(['r1', 'r2']);
    expect(absorbedThoughts.has('a1')).toBe(false);
    expect(entries[0]!.reasoningContent).toBe('why these files');
    expect(entries[0]!.content).toBe(head.content);
  });

  it('keeps the thought of a head whose calls are not all quiet', () => {
    const collapse = createQuietCollapser();
    const head = reasoned('a1', call('e1', 'Edit'), 'native');
    const headWithTail: Message = {
      ...head,
      toolCalls: [call('e1', 'Edit'), call('r1', 'Read')],
      toolResults: [ok('e1'), ok('r1')],
    };
    const { entries, absorbedThoughts } = collapse(
      [headWithTail, reasoned('a2', call('r2', 'Read'), 'native')],
      NONE,
    );
    expect(entries).toHaveLength(1);
    expect(absorbedThoughts.has('a1')).toBe(false);
    expect(entries[0]!.reasoningContent).toBe('weighing a1');
  });

  it('starts a new entry for reasoning before a command, an edit or a failure', () => {
    const collapse = createQuietCollapser();
    const first = reasoned('a1', call('r1', 'Read'), 'think');
    const withTail = (tail: ToolCall, results?: ToolResult[]): Message => ({
      ...reasoned('a2', call('r2', 'Read'), 'think'),
      toolCalls: [call('r2', 'Read'), tail],
      toolResults: results ?? [ok('r2'), ok(tail.id)],
    });
    for (const message of [
      withTail(call('b1', 'Bash')),
      withTail(call('e1', 'Edit')),
      withTail(call('r3', 'Read'), [ok('r2'), failed('r3')]),
    ]) {
      const { entries, absorbedThoughts } = collapse([first, message], NONE);
      expect(entries.map((entry) => entry.id)).toEqual(['a1', 'a2']);
      expect(entries[1]).toBe(message);
      expect(absorbedThoughts.has('a2')).toBe(false);
    }
  });

  it('keeps the thought of a step whose edit waits on a permission prompt', () => {
    const collapse = createQuietCollapser();
    const first = reasoned('a1', call('r1', 'Read'), 'think');
    const second: Message = {
      ...reasoned('a2', call('r2', 'Read'), 'think'),
      toolCalls: [call('r2', 'Read'), call('e1', 'Edit')],
      toolResults: [ok('r2')],
    };
    const { entries } = collapse([first, second], { ...NONE, pendingToolId: 'e1' });
    expect(entries.map((entry) => entry.id)).toEqual(['a1', 'a2']);
    // A pending read is never quiet either.
    const waiting = collapse([first, reasoned('a3', call('r3', 'Read'), 'think')], {
      ...NONE,
      pendingToolId: 'r3',
    });
    expect(waiting.entries.map((entry) => entry.id)).toEqual(['a1', 'a3']);
  });

  it('still merges a message without reasoning whose later call is an edit', () => {
    const collapse = createQuietCollapser();
    const first = assistant('a1', '', [call('r1', 'Read')]);
    const second = assistant('a2', '', [call('r2', 'Read'), call('e1', 'Edit')]);
    const { entries, absorbedThoughts } = collapse([first, second], NONE);
    expect(entries.map((entry) => entry.id)).toEqual(['a1']);
    expect(entries[0]!.toolCalls!.map((c) => c.id)).toEqual(['r1', 'r2', 'e1']);
    expect(absorbedThoughts.has('a1')).toBe(true);
  });

  describe('a single message', () => {
    const thought = '<think>weighing both</think>';

    it('absorbs its thought when two or more quiet calls draw as one group row', () => {
      const collapse = createQuietCollapser();
      const turn = assistant('p1', thought, [call('a', 'Read'), call('b', 'Read')]);
      expect(collapse([turn], NONE).absorbedThoughts.has('p1')).toBe(true);
    });

    it('keeps its thought when a non-quiet call follows the group (finding 4)', () => {
      const collapse = createQuietCollapser();
      const turn = assistant('p1', thought, [
        call('a', 'Read'),
        call('b', 'Read'),
        call('e', 'Edit'),
      ]);
      expect(collapse([turn], NONE).absorbedThoughts.has('p1')).toBe(false);
    });

    it('keeps its thought before a lone quiet call', () => {
      const collapse = createQuietCollapser();
      const turn = assistant('p1', thought, [call('a', 'Read')]);
      expect(collapse([turn], NONE).absorbedThoughts.has('p1')).toBe(false);
    });

    it('keeps its thought when it also speaks', () => {
      const collapse = createQuietCollapser();
      const turn = assistant('p1', `${thought}Checking both.`, [
        call('a', 'Read'),
        call('b', 'Read'),
      ]);
      expect(collapse([turn], NONE).absorbedThoughts.has('p1')).toBe(false);
    });

    it('never absorbs the reasoning of a delegating message (finding 5)', () => {
      const collapse = createQuietCollapser();
      const turn: Message = {
        ...assistant('p1', '', [call('a', 'Read'), call('b', 'Read'), call('s', 'AgentSpawn')]),
        reasoningContent: 'who should look',
      };
      expect(collapse([turn], NONE).absorbedThoughts.has('p1')).toBe(false);
    });
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
    expect(continuesQuietRun(turn, NONE)).toBe(false);
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

describe('read-only shell commands (#459)', () => {
  const context: QuietToolContext = { pinned: new Set(), workspace: '/repo' };
  const message = assistant('m', '', []);
  const bash = (id: string, command: string, extra: Record<string, unknown> = {}) =>
    call(id, 'Bash', { command, ...extra });
  const quiet = (toolCall: ToolCall, result: ToolResult | undefined = ok(toolCall.id)) =>
    isQuietInvocation(toolCall, result, message, context);

  it('folds a successful read-only command, running or finished', () => {
    expect(quiet(bash('a', 'cat src/a.js'))).toBe(true);
    expect(quiet(bash('b', 'rg TODO src | head -n 20'), undefined)).toBe(true);
    expect(quiet(bash('c', 'find src -type f'))).toBe(true);
  });

  it('keeps a git command on its own row', () => {
    // Plain `git ...` runs whatever program the repository's config names.
    for (const command of ['git status', 'git diff --stat', 'git log -5', 'git show HEAD']) {
      expect(quiet(bash('g', command))).toBe(false);
    }
  });

  it('keeps a command that timed out into a background shell on its own row', () => {
    const moved: ToolResult = {
      ...ok('a'),
      data: { backgrounded: true, shell: { id: 'shell-1', status: 'running' } },
    };
    expect(quiet(bash('a', 'cat src/a.js'), moved)).toBe(false);
    // Other data on a result does not matter.
    expect(quiet(bash('b', 'cat src/a.js'), { ...ok('b'), data: { backgrounded: false } })).toBe(
      true,
    );
    expect(quiet(bash('c', 'cat src/a.js'), { ...ok('c'), data: 'text' })).toBe(true);
  });

  it('counts the file an option names against the workspace', () => {
    for (const command of [
      'fd --ignore-file /etc/passwd foo',
      'fd --search-path /etc foo',
      'fd --base-directory ../x foo',
      'rg --ignore-file /etc/passwd foo',
      'rg -f /etc/passwd src',
      'rg --file=/etc/passwd src',
      'rg -f pats /etc',
      'find src -newer /etc/passwd',
      'find src -newer ../x',
      'find . -samefile /etc/passwd',
      'find . -newerat /etc/passwd',
      'file -m /etc/magic a',
      'file -m src/m:/etc/magic a',
      'file --magic=/etc/magic a',
    ]) {
      expect(quiet(bash('o', command)), command).toBe(false);
    }
    for (const command of [
      'rg --ignore-file .ignore foo',
      'fd --ignore-file .fdignore foo',
      'find src -newer a.js',
      'file -m magic.mgc a.bin',
    ]) {
      expect(quiet(bash('i', command)), command).toBe(true);
    }
  });

  it('keeps a glob that can reach the parent directory on its own row', () => {
    for (const command of ['cat .*/secret', 'cat .[.]/x', 'ls .?']) {
      expect(quiet(bash('p', command)), command).toBe(false);
    }
    expect(quiet(bash('q', 'cat src/*.ts'))).toBe(true);
  });

  it('keeps a mutating or unclassifiable command on its own row', () => {
    expect(quiet(bash('a', 'touch x'))).toBe(false);
    expect(quiet(bash('b', 'cat a > b'))).toBe(false);
    expect(quiet(bash('c', 'npm test'))).toBe(false);
    expect(quiet(call('d', 'Bash', {}))).toBe(false);
    expect(quiet(call('e', 'Bash', { command: 42 }))).toBe(false);
  });

  it('keeps a failed, blocked or timed-out read-only command visible', () => {
    expect(quiet(bash('a', 'cat src/a.js'), failed('a'))).toBe(false);
    for (const status of ['blocked', 'timed_out', 'cancelled'] as const) {
      expect(quiet(bash('b', 'cat src/a.js'), { ...failed('b'), status })).toBe(false);
    }
  });

  describe('a search that exits 1', () => {
    /** What shell.ts records for a failed command: stderr, or `Exit code: N` when there is none. */
    const exited = (
      id: string,
      exitCode: number | undefined,
      message = `Exit code: ${exitCode}`,
    ): ToolResult => ({
      version: 2,
      toolCallId: id,
      status: 'error',
      content: '',
      structuredError: {
        code: 'tool_error',
        message,
        retryable: false,
        ...(exitCode === undefined ? {} : { details: { exitCode } }),
      },
    });

    it('folds with no match and no stderr, and still counts as a search', () => {
      const search = bash('a', 'grep -rn TODO src');
      expect(quiet(search, exited('a', 1))).toBe(true);
      expect(quiet(bash('b', 'grep -rn TODO src | wc -l'), exited('b', 1))).toBe(true);
      expect(summarizeQuietRun([{ call: search, result: exited('a', 1) }], context)).toEqual({
        title: 'Search',
        target: 'TODO',
        metadata: ['1 search'],
        running: false,
      });
    });

    it('keeps another exit code on its own row', () => {
      expect(quiet(bash('a', 'grep -rn TODO src'), exited('a', 2))).toBe(false);
      expect(quiet(bash('b', 'grep -rn TODO src'), exited('b', 0))).toBe(false);
    });

    it('keeps one that wrote to stderr on its own row', () => {
      const search = bash('a', 'grep -rn TODO nope');
      expect(quiet(search, exited('a', 1, 'grep: nope: No such file or directory'))).toBe(false);
    });

    it('keeps a failure with no exit code, or no search, on its own row', () => {
      expect(quiet(bash('a', 'grep -rn TODO src'), exited('a', undefined))).toBe(false);
      expect(quiet(bash('b', 'cat a.js'), exited('b', 1))).toBe(false);
      expect(quiet(bash('c', 'grep TODO a.js && cat a.js'), exited('c', 1))).toBe(false);
      expect(quiet(bash('d', 'rg TODO src; ls src'), exited('d', 1))).toBe(false);
    });

    it('keeps a timeout, a cancel and a refusal on its own row', () => {
      for (const status of ['timed_out', 'cancelled', 'blocked'] as const) {
        expect(quiet(bash('a', 'grep TODO src'), { ...exited('a', 1), status })).toBe(false);
      }
    });
  });

  it('keeps a background command, a pinned one and one awaiting permission visible', () => {
    expect(quiet(bash('a', 'cat src/a.js', { run_in_background: true }))).toBe(false);
    expect(
      isQuietInvocation(bash('b', 'cat a.js'), ok('b'), message, {
        ...context,
        pinned: new Set(['b']),
      }),
    ).toBe(false);
    expect(
      isQuietInvocation(bash('c', 'cat a.js'), undefined, message, {
        ...context,
        pendingToolId: 'c',
      }),
    ).toBe(false);
  });

  it('keeps a command that reaches outside the workspace visible', () => {
    expect(quiet(bash('a', 'cat /etc/passwd'))).toBe(false);
    expect(quiet(bash('b', 'cat ../secrets.env'))).toBe(false);
    expect(quiet(bash('c', 'grep -rn x src ../other'))).toBe(false);
    expect(quiet(bash('d', 'cat /repo/src/a.js'))).toBe(true);
    expect(quiet(bash('e', 'cat a.js', { workdir: '/etc' }))).toBe(false);
    expect(quiet(bash('f', 'cat a.js', { workdir: 'src' }))).toBe(true);
    // A relative path resolves from the command's own directory.
    expect(quiet(bash('g', 'cat ../../x', { workdir: 'src' }))).toBe(false);
    expect(quiet(bash('h', 'cat ../a.js', { workdir: 'src' }))).toBe(true);
  });

  it('treats BashOutput as before', () => {
    expect(quiet(call('a', 'BashOutput', { shell_id: 'x' }))).toBe(true);
  });

  it('summarizes reads, searches and listings together', () => {
    const summary = summarizeQuietRun([
      { call: bash('a', 'cat src/a.js'), result: ok('a') },
      { call: bash('b', 'grep -rn TODO src'), result: ok('b') },
      { call: bash('c', 'ls src'), result: ok('c') },
    ]);
    expect(summary).toEqual({
      title: 'Read',
      target: 'a.js',
      metadata: ['1 file', '1 search', '1 listing'],
      running: false,
    });
  });

  it('dedupes shell reads with Read, and counts listings after searches and before lookups', () => {
    const summary = summarizeQuietRun([
      { call: call('a', 'Read', { file_path: 'src/a.js' }), result: ok('a') },
      { call: bash('b', 'cat a.js b.js'), result: ok('b') },
      { call: bash('c', 'ls src && ls'), result: ok('c') },
      { call: call('d', 'TaskList'), result: ok('d') },
    ]);
    expect(summary.target).toBe('a.js, b.js');
    expect(summary.metadata).toEqual(['2 files', '2 listings', '1 lookup']);
  });

  it('titles a run by search, then listing, then check', () => {
    expect(
      summarizeQuietRun([
        { call: bash('a', 'ls src'), result: ok('a') },
        { call: bash('b', 'rg foo'), result: ok('b') },
      ]),
    ).toMatchObject({ title: 'Search', target: 'foo', metadata: ['1 search', '1 listing'] });
    expect(
      summarizeQuietRun([
        { call: bash('a', 'ls src'), result: ok('a') },
        { call: bash('b', 'pwd'), result: ok('b') },
        { call: call('c', 'TaskList'), result: ok('c') },
      ]),
    ).toMatchObject({
      title: 'List',
      target: 'src, .',
      metadata: ['2 listings', '1 lookup'],
    });
  });

  it('names the current directory for a listing with no path, and a file for a read', () => {
    expect(summarizeQuietRun([{ call: bash('a', 'ls'), result: ok('a') }])).toMatchObject({
      title: 'List',
      target: '.',
    });
    expect(
      summarizeQuietRun([
        { call: bash('a', 'ls'), result: ok('a') },
        { call: bash('b', 'cat src/a.js'), result: ok('b') },
      ]),
    ).toMatchObject({ title: 'Read', target: 'a.js' });
  });

  it('memoizes a classification per command, and works through a context', () => {
    const memo = createShellPartsMemo();
    const parts = memo('ls src');
    // The same array comes back: it was not classified again.
    expect(memo('ls src')).toBe(parts);
    const withMemo: QuietToolContext = { ...context, shellParts: memo };
    expect(isQuietInvocation(bash('a', 'ls src'), ok('a'), message, withMemo)).toBe(true);
    expect(isQuietInvocation(bash('b', 'touch x'), ok('b'), message, withMemo)).toBe(false);
  });

  it('bounds the memo and still answers after evicting', () => {
    const memo = createShellPartsMemo(2);
    const first = memo('ls a');
    memo('ls b');
    memo('ls c');
    expect(memo('ls a')).toEqual(first);
    expect(memo('touch x')).toBeUndefined();
    expect(memo('touch x')).toBeUndefined();
  });

  it('uses the context memo for the summary too', () => {
    const seen: string[] = [];
    const summary = summarizeQuietRun([{ call: bash('a', 'cat src/a.js'), result: ok('a') }], {
      ...context,
      shellParts: (command) => {
        seen.push(command);
        return [{ kind: 'read', path: 'x.ts' }];
      },
    });
    expect(seen).toEqual(['cat src/a.js']);
    expect(summary.target).toBe('x.ts');
  });

  it('folds three one-command turns into one entry', () => {
    const turns = [
      assistant('m1', '', [bash('a', 'cat src/a.js')]),
      assistant('m2', '', [bash('b', 'grep -rn TODO src')]),
      assistant('m3', '', [bash('c', 'ls src')]),
    ];
    const { entries } = createQuietCollapser()(turns, context);
    expect(entries).toHaveLength(1);
    expect((entries[0] as Message).toolCalls).toHaveLength(3);
  });

  it('keeps a mutating command out of the fold', () => {
    const turns = [
      assistant('m1', '', [bash('a', 'cat src/a.js')]),
      assistant('m2', '', [bash('b', 'touch x')]),
      assistant('m3', '', [bash('c', 'ls src')]),
    ];
    expect(createQuietCollapser()(turns, context).entries).toHaveLength(3);
  });

  it('absorbs reasoning before read-only commands', () => {
    const turns = [
      reasonedRead('m1', bash('a', 'cat src/a.js'), 'think'),
      reasonedRead('m2', bash('b', 'rg TODO src'), 'think'),
      reasonedRead('m3', bash('c', 'ls src'), 'native'),
    ];
    const { entries, absorbedThoughts } = createQuietCollapser()(turns, context);
    expect(entries).toHaveLength(1);
    expect(absorbedThoughts.has('m1')).toBe(true);
  });

  it('groups consecutive read-only commands in one message', () => {
    const rows = groupQuietInvocations(
      [
        { call: bash('a', 'cat a.js'), result: ok('a') },
        { call: bash('b', 'ls'), result: ok('b') },
        { call: bash('c', 'touch x'), result: ok('c') },
      ],
      message,
      context,
    );
    expect(rows).toEqual([
      { kind: 'quiet', indices: [0, 1] },
      { kind: 'single', index: 2 },
    ]);
  });
});
