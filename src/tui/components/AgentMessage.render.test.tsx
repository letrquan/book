import chalk from 'chalk';
import { afterEach, describe, expect, it } from 'vitest';
import { render, cleanup } from 'ink-testing-library';
import { ThemeContext, DEFAULT_THEME } from '../theme.js';
import { AgentMessage } from './AgentMessage.js';
import type { Message } from '../../types/messages.js';
import type { ToolResult } from '../../types/tools.js';

/**
 * What the transcript does with a reasoning tag the provider opened and never
 * closed.
 *
 * The rule lives in `splitReasoningParts`, but the condition that decides when
 * to apply it lives here, at the call site — it needs the turn's tool calls,
 * which the helper never sees. Getting that condition wrong is not a cosmetic
 * slip in either direction: too strict and a finished answer collapses into a
 * one-line thought, too loose and private reasoning is promoted into the answer
 * column on every tool-call turn, past the reader's thinking-display setting.
 */

afterEach(cleanup);

function stripAnsi(value: string | undefined): string {
  return (value ?? '').replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '');
}

function assistant(content: string, toolCalls?: Message['toolCalls']): Message {
  return {
    id: 'assistant-1',
    role: 'assistant',
    content,
    includeInContext: true,
    timestamp: 1,
    toolCalls,
  };
}

// Screen-reader mode is deliberately excluded: it never collapses a thought, so
// reasoning is on screen either way and the distinction under test disappears.
function frameOf(message: Message, props: { isStreaming?: boolean; showThinking?: boolean } = {}) {
  const { lastFrame } = render(
    <ThemeContext.Provider value={DEFAULT_THEME}>
      <AgentMessage
        message={message}
        isStreaming={props.isStreaming ?? false}
        showThinking={props.showThinking}
        reducedMotion
        terminalWidth={80}
      />
    </ThemeContext.Provider>,
  );
  return stripAnsi(lastFrame());
}

const UNCLOSED_ANSWER = '<reasoning_context>ranking them, then RECOVERED-REPORT';

describe('AgentMessage unclosed reasoning tags', () => {
  it('shows an answer the model left behind an unclosed tag once the turn ends', () => {
    // The whole bug: a completed turn whose report never escaped the tag rendered
    // as a lone `thought` row, which reads as an agent that quit mid-task.
    expect(frameOf(assistant(UNCLOSED_ANSWER))).toContain('RECOVERED-REPORT');
  });

  it('files it as reasoning while the turn is still streaming', () => {
    // Mid-stream the text is on screen, but inside the thinking rail rather than
    // as answer prose — the provider may still close the tag.
    const frame = frameOf(assistant(UNCLOSED_ANSWER), { isStreaming: true });

    expect(frame).toContain('Thinking');
    expect(frameOf(assistant(UNCLOSED_ANSWER))).not.toContain('Thinking');
  });

  it('keeps it collapsed on a turn that called a tool', () => {
    // Such a turn has not finished speaking and never lost an answer — the loop
    // counts it as productive on its tool calls alone. Promoting its narration
    // would only publish a thought the reader had collapsed.
    const withTool = assistant('<reasoning_context>let me look at the file', [
      { id: 'Read-1', name: 'Read', arguments: { filePath: 'a.ts' } },
    ]);

    expect(frameOf(withTool)).not.toContain('let me look at the file');
  });

  it('honours showThinking=false on a turn that called a tool', () => {
    // Promoted parts render as markdown, which has no `showThinking` gate. A
    // reader who turned thinking off must not get reasoning back this way.
    const withTool = assistant('<reasoning_context>private deliberation', [
      { id: 'Read-1', name: 'Read', arguments: { filePath: 'a.ts' } },
    ]);

    expect(frameOf(withTool, { showThinking: false })).not.toContain('private deliberation');
  });
});

describe('AgentMessage empty reasoning blocks', () => {
  // Routers that inline thinking as `<think></think>` emit an empty block on
  // every tool-call turn. Each one rendered as a `thought · 0 lines` row: a
  // toggle that expands to nothing, stacked between every wave of tool rows.
  it('renders no thought row for an empty block on a tool-call turn', () => {
    const withTool = assistant('<think></think>', [
      { id: 'Read-1', name: 'Read', arguments: { filePath: 'a.ts' } },
    ]);
    const frame = frameOf(withTool);

    expect(frame).not.toContain('thought');
    expect(frame).not.toContain('0 lines');
    expect(frame).not.toContain('<think>');
  });

  it('renders no thought row for an empty block ahead of the answer', () => {
    const frame = frameOf(assistant('<think></think>The answer.'));

    expect(frame).toContain('The answer.');
    expect(frame).not.toContain('thought');
    expect(frame).not.toContain('<think>');
  });

  it('still collapses a block that has a body', () => {
    const frame = frameOf(assistant('<think>weighing</think>The answer.'));

    expect(frame).toContain('thought · 1 line');
    expect(frame).not.toContain('weighing');
  });
});

/**
 * A step of work versus the answer.
 *
 * Five rows per action — a thought, a blank, the sentence before acting, a
 * blank, the tool rows — made the whole transcript one undifferentiated
 * column, and the sentence that introduced the work was set in the same ink as
 * the final answer. A step now draws as one quiet unit, and the answer is the
 * only full-ink text in a turn.
 */
describe('AgentMessage work steps', () => {
  const NARRATION = 'Let me run the tests.';

  /** The truecolor escape chalk writes for a `#RRGGBB` token. */
  function ink(token: string): string {
    const [r, g, b] = [1, 3, 5].map((offset) => parseInt(token.slice(offset, offset + 2), 16)) as [
      number,
      number,
      number,
    ];
    return `\u001b[38;2;${r};${g};${b}m`;
  }

  // Ink styles through chalk, which emits nothing off a TTY; force truecolor
  // so the ink a turn is set in is visible in the frame.
  function frameFor(
    message: Message,
    screenReader?: boolean,
    transcriptMode?: 'compact' | 'detailed',
  ): string {
    const level = chalk.level;
    chalk.level = 3;
    try {
      const { lastFrame } = render(
        <ThemeContext.Provider value={DEFAULT_THEME}>
          <AgentMessage
            message={message}
            isStreaming={false}
            showThinking
            reducedMotion
            terminalWidth={80}
            screenReader={screenReader}
            transcriptMode={transcriptMode}
          />
        </ThemeContext.Provider>,
      );
      return lastFrame() ?? '';
    } finally {
      chalk.level = level;
    }
  }

  function stepFrame(screenReader?: boolean, transcriptMode?: 'compact' | 'detailed'): string {
    return frameFor(
      {
        ...assistant('step-1', [
          { id: 'bash-1', name: 'Bash', arguments: { command: 'npm test' } },
        ]),
        reasoningContent: 'check config',
        content: NARRATION,
        toolResults: [
          { version: 2, toolCallId: 'bash-1', status: 'success', content: 'ok' } as ToolResult,
        ],
      },
      screenReader,
      transcriptMode,
    );
  }

  /** An answer: a turn whose only call is bookkeeping, or none at all. */
  function answerFrame(options: {
    toolName?: string;
    content: string;
    reasoningContent?: string;
  }): string {
    const { toolName, content, reasoningContent } = options;
    return frameFor({
      ...assistant('answer-1', toolName ? [{ id: 'call-1', name: toolName, arguments: {} }] : []),
      content,
      reasoningContent,
      toolResults: toolName
        ? [{ version: 2, toolCallId: 'call-1', status: 'success', content: 'ok' } as ToolResult]
        : [],
    });
  }

  it('draws a step as one unit, with no blank rows inside it', () => {
    const lines = stripAnsi(stepFrame()).split('\n');
    const thought = lines.findIndex((line) => line.includes('thought'));
    const narration = lines.findIndex((line) => line.includes(NARRATION));
    const tool = lines.findIndex((line, index) => index > narration && line.trim().length > 0);

    expect(thought).toBeGreaterThanOrEqual(0);
    expect(lines.slice(thought + 1, narration)).toEqual([]);
    expect(lines.slice(narration + 1, tool)).toEqual([]);
  });

  it('speaks a step in the secondary voice, so the answer is the only full-ink text', () => {
    const frame = stepFrame();

    expect(frame).toContain(`${ink(DEFAULT_THEME.subtle)}${NARRATION}`);
    expect(frame).not.toContain(`${ink(DEFAULT_THEME.text)}${NARRATION}`);
  });

  it('keeps an answer in full ink and one blank row above its bookkeeping', () => {
    const frame = answerFrame({ toolName: 'TodoWrite', content: 'All done.' });
    const lines = stripAnsi(frame).split('\n');
    const answer = lines.findIndex((line) => line.includes('All done.'));
    const tool = lines.findIndex((line, index) => index > answer && line.trim().length > 0);

    expect(frame).toContain(`${ink(DEFAULT_THEME.text)}All done.`);
    expect(lines.slice(answer + 1, tool)).toEqual(['']);
  });

  it('keeps a question in full ink, because the turn ends with the question', () => {
    const frame = answerFrame({ toolName: 'AskUserQuestion', content: 'Which option?' });

    expect(frame).toContain(`${ink(DEFAULT_THEME.text)}Which option?`);
    expect(frame).not.toContain(`${ink(DEFAULT_THEME.subtle)}Which option?`);
  });

  it('keeps the blank row between a thought and the answer it leads to', () => {
    const frame = answerFrame({ content: 'The answer.', reasoningContent: 'think' });
    const lines = stripAnsi(frame).split('\n');
    const thought = lines.findIndex((line) => line.includes('thought'));
    const answer = lines.findIndex((line) => line.includes('The answer.'));

    expect(lines.slice(thought + 1, answer)).toEqual(['']);
  });

  it('still names the answer for a screen reader', () => {
    // Spacing carries the boundary for the eye; a screen reader cannot infer it
    // from whitespace, so the spoken marker stays.
    expect(stripAnsi(stepFrame(true))).toContain('Answer:');
  });

  it('greys the check on a finished tool row, so success is the default', () => {
    const frame = stepFrame();

    expect(stripAnsi(frame)).toContain('✓');
    expect(frame).toContain(`${ink(DEFAULT_THEME.inactive)}✓`);
    expect(frame).not.toContain(`${ink(DEFAULT_THEME.success)}✓`);
  });

  it('draws the collapsed thought row at reading weight, not the terminal faint attribute', () => {
    // SGR 2 on an already-muted grey put this row near 2.5:1 — below any
    // threshold a long read survives.
    const thought = stepFrame()
      .split('\n')
      .find((line) => stripAnsi(line).includes('thought'))!;

    expect(thought).toContain(ink(DEFAULT_THEME.inactive));
    expect(thought).not.toContain('\u001b[2m');
  });

  it('draws the expanded thought header at reading weight too', () => {
    // The detailed transcript reopens a thought; its header was still dimmed, so
    // the one mode that shows more of a turn printed its least important line
    // in the faintest ink on screen.
    const header = stepFrame(false, 'detailed')
      .split('\n')
      .find((line) => stripAnsi(line).includes('Thought'))!;

    expect(header).not.toContain('\u001b[2m');
  });

  it('leaves a step to the detailed transcript, which needs its blank rows', () => {
    // Ctrl+O expands every block in a turn, and the blank rows between them are
    // what keeps one call's output from running into the next call's header.
    const frame = stepFrame(false, 'detailed');
    const lines = stripAnsi(frame).split('\n');
    const narration = lines.findIndex((line) => line.includes(NARRATION));

    expect(frame).toContain(`${ink(DEFAULT_THEME.text)}${NARRATION}`);
    expect(frame).not.toContain(`${ink(DEFAULT_THEME.subtle)}${NARRATION}`);
    expect(lines[narration + 1]).toBe('');
  });

  it('quiets the code inside a step, since a fenced block is part of its prose', () => {
    // Only `mdCodeText` was muted: the highlight tokens kept full colour, so a
    // snippet a step showed to explain its step was the loudest thing in a turn.
    const frame = frameFor({
      ...assistant('step-2', [{ id: 'bash-1', name: 'Bash', arguments: { command: 'npm test' } }]),
      content: 'Patching:\n\n```ts\nconst answer = 42;\n```',
      toolResults: [
        { version: 2, toolCallId: 'bash-1', status: 'success', content: 'ok' } as ToolResult,
      ],
    });

    expect(frame).toContain(ink(DEFAULT_THEME.subtle));
    expect(frame).not.toContain(ink(DEFAULT_THEME.mdCodeKeyword));
  });

  it('greys the check on a local event row, since success is the default there too', () => {
    const frame = frameFor({
      ...assistant('local-1'),
      kind: 'local',
      content: '✓ Background shell 1 exited',
    });

    expect(frame).toContain(`${ink(DEFAULT_THEME.inactive)}✓`);
    expect(frame).not.toContain(`${ink(DEFAULT_THEME.success)}✓`);
  });
});
