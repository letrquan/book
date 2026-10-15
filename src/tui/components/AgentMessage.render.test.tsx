import chalk from 'chalk';
import { Box } from 'ink';
import { afterEach, describe, expect, it } from 'vitest';
import { render, cleanup } from 'ink-testing-library';
import { ThemeContext, DEFAULT_THEME } from '../theme.js';
import { AgentMessage, MutationGroupRow } from './AgentMessage.js';
import { QuietToolRun } from './QuietToolRun.js';
import { transcriptGrid } from '../layout.js';
import type { Message } from '../../types/messages.js';
import type { ToolResult } from '../../types/tools.js';
import type { PendingPermissionRequest } from '../../session/agent-interactions.js';

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
 * A thought before a tool call is hidden in compact mode (#470).
 *
 * The rule is "this step calls a tool", not "this row is quiet": a Bash or Edit
 * step reasons just as much as a Read does, and its row says what came of it. An
 * answer has no call, so its thought stays. Ctrl+O and screen readers keep every
 * thought, and so does the one still streaming before its call lands.
 */
describe('AgentMessage thoughts before a tool call (#470)', () => {
  const bashCall = { id: 'bash-1', name: 'Bash', arguments: { command: 'seq 1 3' } };
  const bashResult = {
    version: 2,
    toolCallId: 'bash-1',
    status: 'success',
    content: '1\n2\n3',
  } as ToolResult;

  function toolStep(
    how: 'think' | 'native',
    prose = '',
    calls: Message['toolCalls'] = [bashCall],
  ): Message {
    return {
      ...assistant(how === 'think' ? `<think>weigh it\nthen go</think>${prose}` : prose, calls),
      ...(how === 'native' ? { reasoningContent: 'weigh it\nthen go' } : {}),
      toolResults: [bashResult],
    };
  }

  function view(
    message: Message,
    props: {
      transcriptMode?: 'compact' | 'detailed';
      screenReader?: boolean;
      isStreaming?: boolean;
      showThinking?: boolean;
    } = {},
  ): string {
    const { lastFrame } = render(
      <ThemeContext.Provider value={DEFAULT_THEME}>
        <AgentMessage
          message={message}
          isStreaming={props.isStreaming ?? false}
          showThinking={props.showThinking ?? true}
          transcriptMode={props.transcriptMode ?? 'compact'}
          screenReader={props.screenReader}
          reducedMotion
          terminalWidth={80}
        />
      </ThemeContext.Provider>,
    );
    return stripAnsi(lastFrame());
  }

  it.each(['think', 'native'] as const)(
    'draws the tool row and no thought row in compact mode (%s)',
    (how) => {
      const frame = view(toolStep(how));

      expect(frame).toContain('seq 1 3');
      expect(frame).not.toContain('thought');
      expect(frame).not.toContain('weigh it');
      // Nothing above the row: it sits where a step with no thought puts it.
      expect(frame.split('\n')[0]).toContain('seq 1 3');
    },
  );

  it.each(['think', 'native'] as const)(
    'keeps the thought row in the detailed transcript (%s)',
    (how) => {
      const frame = view(toolStep(how), { transcriptMode: 'detailed' });

      expect(frame).toContain('seq 1 3');
      expect(frame).toContain('Thought - 2 lines');
    },
  );

  it.each(['think', 'native'] as const)('keeps every thought for a screen reader (%s)', (how) => {
    const frame = view(toolStep(how), { screenReader: true });

    expect(frame).toContain('seq 1 3');
    expect(frame).toContain('Thought');
  });

  it('still hides it for showThinking=false in detailed mode', () => {
    const frame = view(toolStep('think'), { transcriptMode: 'detailed', showThinking: false });

    expect(frame).toContain('seq 1 3');
    expect(frame).not.toContain('Thought');
  });

  it.each(['think', 'native'] as const)(
    'keeps the thought row of a final answer with no tool call (%s)',
    (how) => {
      const answer: Message = {
        ...assistant(
          how === 'think' ? '<think>weigh it\nthen go</think>The answer is 3.' : 'The answer is 3.',
        ),
        ...(how === 'native' ? { reasoningContent: 'weigh it\nthen go' } : {}),
      };
      const frame = view(answer);

      expect(frame).toContain('▸ thought · 2 lines');
      expect(frame).toContain('The answer is 3.');
    },
  );

  it('keeps the prose of a tool step, with no thought row and no blank row before the tool', () => {
    const lines = view(toolStep('think', 'Step 6 is next: rename the helper.')).split('\n');
    const prose = lines.findIndex((line) => line.includes('Step 6 is next'));
    const tool = lines.findIndex((line) => line.includes('seq 1 3'));

    expect(lines.some((line) => line.includes('thought'))).toBe(false);
    // The prose is the first row: the hidden thought leaves no blank row behind.
    expect(prose).toBe(0);
    expect(tool).toBe(prose + 1);
  });

  it('keeps the same spacing for a step whose thought is native', () => {
    const lines = view(toolStep('native', 'Step 6 is next: rename the helper.')).split('\n');

    expect(lines[0]).toContain('Step 6 is next');
    expect(lines[1]).toContain('seq 1 3');
  });

  it('draws the same rows as a step that never reasoned', () => {
    const quiet = view(toolStep('think'));
    const never = view({ ...toolStep('think'), content: '' });

    expect(quiet).toBe(never);
  });

  it('keeps a thought that is still streaming while no tool call has landed', () => {
    const thinking = assistant('<think>weigh it\nthen go</think>');
    const frame = view(thinking, { isStreaming: true });

    expect(frame).toContain('Thinking');
    expect(frame).toContain('then go');
  });

  it('shows the native reasoning of a streaming message with no call yet', () => {
    const frame = view(
      { ...assistant(''), reasoningContent: 'weigh it\nthen go' },
      { isStreaming: true },
    );

    expect(frame).toContain('Thinking');
    expect(frame).toContain('weigh it');
  });

  it('hides a streaming thought once the call lands, and the row shows the activity', () => {
    const running: Message = { ...toolStep('think'), toolResults: [] };
    const frame = view(running, { isStreaming: true });

    expect(frame).not.toContain('Thinking');
    expect(frame).not.toContain('weigh it');
    expect(frame).toContain('seq 1 3');
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
    pendingPermission?: PendingPermissionRequest,
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
            pendingPermission={pendingPermission}
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
    // The thought behind the call is not drawn (#470): the sentence and the tool
    // row are the whole step.
    const lines = stripAnsi(stepFrame()).split('\n');
    const narration = lines.findIndex((line) => line.includes(NARRATION));
    const tool = lines.findIndex((line, index) => index > narration && line.trim().length > 0);

    expect(lines.some((line) => line.includes('thought'))).toBe(false);
    expect(narration).toBe(0);
    expect(lines.slice(narration + 1, tool)).toEqual([]);
  });

  it('speaks a step in the secondary voice, so the answer is the only full-ink text', () => {
    const frame = stepFrame();

    expect(frame).toContain(`${ink(DEFAULT_THEME.subtle)}${NARRATION}`);
    expect(frame).not.toContain(`${ink(DEFAULT_THEME.text)}${NARRATION}`);
  });

  it('keeps a step in full ink while its call waits for your approval', () => {
    // The sentence behind a pending call is the one you are being asked to
    // judge, so greying it hides it at the worst possible moment.
    const frame = frameFor(
      {
        ...assistant(NARRATION, [
          { id: 'bash-1', name: 'Bash', arguments: { command: 'npm test' } },
        ]),
        toolResults: [
          { version: 2, toolCallId: 'bash-1', status: 'success', content: 'ok' } as ToolResult,
        ],
      },
      undefined,
      undefined,
      { toolCall: { id: 'bash-1', name: 'Bash', arguments: { command: 'npm test' } } },
    );

    expect(frame).toContain(`${ink(DEFAULT_THEME.text)}${NARRATION}`);
    expect(frame).not.toContain(`${ink(DEFAULT_THEME.subtle)}${NARRATION}`);
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

  /** Render once as the last entry of its turn, then again once a step follows it. */
  function framesAsStepArrives(message: Message): { before: string; after: string } {
    const level = chalk.level;
    chalk.level = 3;
    try {
      const entry = (continuesTurn: boolean) => (
        <ThemeContext.Provider value={DEFAULT_THEME}>
          <AgentMessage
            message={message}
            isStreaming={false}
            showThinking
            reducedMotion
            terminalWidth={80}
            continuesTurn={continuesTurn}
          />
        </ThemeContext.Provider>
      );
      const view = render(entry(false));
      const before = view.lastFrame() ?? '';
      view.rerender(entry(true));
      return { before, after: view.lastFrame() ?? '' };
    } finally {
      chalk.level = level;
    }
  }

  it('speaks a plan update in the secondary voice once a step follows it', () => {
    // `I'll clone, install, and launch that repo` + TodoWrite sat in full ink
    // between dimmed steps: the turn's least informative line was its brightest.
    // The same object re-renders, so this also holds the memo to the new prop.
    const { before, after } = framesAsStepArrives({
      ...assistant(NARRATION, [{ id: 'todo-1', name: 'TodoWrite', arguments: { todos: [] } }]),
      toolResults: [
        { version: 2, toolCallId: 'todo-1', status: 'success', content: 'ok' } as ToolResult,
      ],
    });

    expect(before).toContain(`${ink(DEFAULT_THEME.text)}${NARRATION}`);
    expect(after).toContain(`${ink(DEFAULT_THEME.subtle)}${NARRATION}`);
    expect(after).not.toContain(`${ink(DEFAULT_THEME.text)}${NARRATION}`);
  });

  it('keeps a question in full ink after the work it led to', () => {
    // A question you answered is a landmark, like your own turn.
    const { after } = framesAsStepArrives({
      ...assistant('Which option?', [{ id: 'ask-1', name: 'AskUserQuestion', arguments: {} }]),
      toolResults: [
        { version: 2, toolCallId: 'ask-1', status: 'success', content: 'ok' } as ToolResult,
      ],
    });

    expect(after).toContain(`${ink(DEFAULT_THEME.text)}Which option?`);
    expect(after).not.toContain(`${ink(DEFAULT_THEME.subtle)}Which option?`);
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
    const thought = answerFrame({ content: 'The answer.', reasoningContent: 'check config' })
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

  it('renders quiet tool summary as exactly one line ending in … at narrow width with long target', () => {
    const width = 24;
    const grid = transcriptGrid(width);
    const view = render(
      <ThemeContext.Provider value={DEFAULT_THEME}>
        <Box width={width}>
          <QuietToolRun
            summary={{
              title: 'Read',
              target: 'src/components/very/deeply/nested/path/to/component/File.tsx',
              metadata: ['42 lines'],
              running: false,
            }}
            grid={grid}
            reducedMotion
          />
        </Box>
      </ThemeContext.Provider>,
    );

    const rendered = stripAnsi(view.lastFrame());
    const lines = rendered.split('\n').filter((line) => line.trim().length > 0);
    expect(lines).toHaveLength(1);
    expect(lines[0]!.trimEnd()).toMatch(/…$/);
  });

  it('renders mutation group summary as exactly one line ending in … at narrow width with long target', () => {
    const width = 20;
    const grid = transcriptGrid(width);
    const view = render(
      <ThemeContext.Provider value={DEFAULT_THEME}>
        <Box width={width}>
          <MutationGroupRow
            createdOnly={false}
            fileCount={999999999}
            addedLines={500}
            removedLines={200}
            grid={grid}
            screenReader={false}
          />
        </Box>
      </ThemeContext.Provider>,
    );

    const rendered = stripAnsi(view.lastFrame());
    const lines = rendered.split('\n').filter((line) => line.trim().length > 0);
    expect(lines).toHaveLength(1);
    expect(lines[0]!.trimEnd()).toMatch(/…$/);
  });
});
