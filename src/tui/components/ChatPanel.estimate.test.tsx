import { afterEach, describe, expect, it } from 'vitest';
import { render, cleanup } from 'ink-testing-library';
import { ThemeContext, DEFAULT_THEME } from '../theme.js';
import { ChatPanel, estimateTimelineRows } from './ChatPanel.js';
import { createShellPartsMemo, type QuietToolContext } from '../quiet-tools.js';
import { messagesFollowedByWork } from './transcript-messages.js';
import type { ToolCall, ToolResult } from '../../types/tools.js';
import type { Message } from '../../types/messages.js';

function stripAnsi(value: string | undefined): string {
  return (value ?? '').replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '');
}

function step(
  id: string,
  content: string,
  call: Omit<ToolCall, 'id'>,
  result: Omit<ToolResult, 'toolCallId' | 'version'>,
): Message {
  const callId = `${id}-call`;
  return {
    id,
    role: 'assistant',
    content,
    includeInContext: true,
    timestamp: 1,
    toolCalls: [{ id: callId, ...call }],
    toolResults: [{ version: 2, toolCallId: callId, ...result }],
  };
}

/** A turn shaped like the duel's demo: narrated steps of every kind, then the answer. */
function demoTurn(): Message[] {
  return [
    { id: 'u1', role: 'user', content: 'is memory on?', includeInContext: true, timestamp: 1 },
    step(
      'a1',
      'I will search the project for memory settings to see where the default lives.',
      { name: 'Grep', arguments: { pattern: 'memory', path: '.' } },
      { status: 'success', content: 'src/settings.ts:3:memory\nREADME.md:9:memory' },
    ),
    step(
      'a2',
      'I will inspect the memory schema.',
      { name: 'Read', arguments: { file_path: 'src/settings.ts' } },
      { status: 'success', content: '1: export const a = 1;\n2: export const b = 2;' },
    ),
    step(
      'a3',
      'I will list the source files.',
      { name: 'Bash', arguments: { command: 'ls -la src' } },
      { status: 'success', content: 'total 8\na.ts\nb.ts\nc.ts\n' },
    ),
    step(
      'a4',
      'I will run the tests.',
      { name: 'Bash', arguments: { command: 'node test.js' } },
      {
        status: 'error',
        content: 'ok 1\nok 2\n',
        structuredError: {
          code: 'command_failed',
          message: 'not ok 3 - expected true, got false',
          retryable: false,
          details: { exitCode: 1 },
        },
      },
    ),
    step(
      'a5',
      'The default is wrong. I will turn it on.',
      {
        name: 'Edit',
        arguments: { file_path: 'src/settings.ts', old_string: 'false', new_string: 'true' },
      },
      {
        status: 'success',
        content: [
          '@@ -1,7 +1,7 @@',
          ' export const DEFAULTS = {',
          '   name: "memory",',
          '   level: 2,',
          '-  enabled: false,',
          '+  enabled: true,',
          '   autoSave: true,',
          '   max: 200,',
          ' };',
        ].join('\n'),
        artifacts: {
          fileMutation: {
            kind: 'update',
            filePath: 'src/settings.ts',
            addedLines: 1,
            removedLines: 1,
          },
        },
      },
    ),
    step(
      'a6',
      'I will add a note to the changelog.',
      { name: 'Write', arguments: { file_path: 'CHANGELOG.md', content: '# Changelog\n' } },
      {
        status: 'success',
        content: '@@ -0,0 +1,3 @@\n+# Changelog\n+\n+- Memory is on by default again.',
        artifacts: {
          fileMutation: {
            kind: 'create',
            filePath: 'CHANGELOG.md',
            addedLines: 3,
            removedLines: 0,
          },
        },
      },
    ),
    {
      id: 'a7',
      role: 'assistant',
      content: 'Memory was off by default; it is on now.\n\nAll tests pass.',
      includeInContext: true,
      timestamp: 1,
    },
    // History: the next prompt trims the answer's trailing margin, as it does on screen.
    { id: 'u2', role: 'user', content: 'thanks', includeInContext: true, timestamp: 2 },
  ];
}

afterEach(() => {
  cleanup();
});

describe('the transcript row estimate', () => {
  // The virtual transcript sizes the history it has not drawn from this estimate. An estimate
  // short of the rendered height lets the scrollbar and the jump to the bottom land in the wrong
  // place; this turn has every kind of item the redesign draws: captions, results in words, a
  // command preview, a failure's tail, a diff and a new file.
  // ink-testing-library draws on a 100-column stdout, so the widest case stays inside it.
  it.each([60, 73, 99])('matches the height a demo-like turn renders at %i columns', (width) => {
    const messages = demoTurn();
    const view = render(
      <ThemeContext.Provider value={DEFAULT_THEME}>
        <ChatPanel messages={messages} terminalWidth={width} terminalHeight={200} />
      </ThemeContext.Provider>,
    );
    const rendered = stripAnsi(view.lastFrame()).split('\n').length;
    const quietTools: QuietToolContext = { pinned: new Set(), shellParts: createShellPartsMemo() };
    const estimated = messages.reduce(
      (rows, message) => rows + estimateTimelineRows(message, width, quietTools),
      0,
    );
    // The first entry's blank row above it is the one the transcript does not draw.
    expect(estimated - 1).toBe(rendered);
  });

  /** The estimate ChatPanel makes for each entry, with what it knows of the turn around it. */
  function estimateAll(messages: Message[], width: number): number {
    const quietTools: QuietToolContext = { pinned: new Set(), shellParts: createShellPartsMemo() };
    const followedByWork = messagesFollowedByWork(messages, messages[0]?.id);
    return messages.reduce(
      (rows, message) =>
        rows +
        estimateTimelineRows(message, width, quietTools, 'compact', {
          continuesTurn: followedByWork.has(message.id),
        }),
      0,
    );
  }

  function renderedRows(messages: Message[], width: number): number {
    const view = render(
      <ThemeContext.Provider value={DEFAULT_THEME}>
        <ChatPanel messages={messages} terminalWidth={width} terminalHeight={200} />
      </ThemeContext.Provider>,
    );
    return stripAnsi(view.lastFrame()).split('\n').length;
  }

  it('sizes a failed command with no output as its heading and its exit code', () => {
    const messages: Message[] = [
      { id: 'u1', role: 'user', content: 'run it', includeInContext: true, timestamp: 1 },
      step(
        'a1',
        'I will run the script.',
        { name: 'Bash', arguments: { command: 'false' } },
        {
          status: 'error',
          content: '',
          structuredError: {
            code: 'command_failed',
            message: '',
            retryable: false,
            details: { exitCode: 1 },
          },
        },
      ),
      { id: 'a2', role: 'assistant', content: 'It failed.', includeInContext: true, timestamp: 1 },
      { id: 'u2', role: 'user', content: 'ok', includeInContext: true, timestamp: 2 },
    ];
    expect(estimateAll(messages, 73) - 1).toBe(renderedRows(messages, 73));
  });

  it('sets prose that a step of work follows against its call, as the transcript does', () => {
    const messages: Message[] = [
      { id: 'u1', role: 'user', content: 'fix it', includeInContext: true, timestamp: 1 },
      step(
        'a1',
        'I will plan the fix first.',
        {
          name: 'TodoWrite',
          arguments: {
            todos: [{ content: 'Fix it', status: 'in_progress', activeForm: 'Fixing' }],
          },
        },
        { status: 'success', content: 'ok' },
      ),
      step(
        'a2',
        'I will read the settings.',
        { name: 'Read', arguments: { file_path: 'src/settings.ts' } },
        { status: 'success', content: '1: export const a = 1;' },
      ),
      { id: 'a3', role: 'assistant', content: 'Done.', includeInContext: true, timestamp: 1 },
      { id: 'u2', role: 'user', content: 'ok', includeInContext: true, timestamp: 2 },
    ];
    expect(estimateAll(messages, 73) - 1).toBe(renderedRows(messages, 73));
  });
});
