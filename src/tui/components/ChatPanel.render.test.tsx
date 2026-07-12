import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, cleanup } from 'ink-testing-library';
import { ThemeContext, DEFAULT_THEME } from '../theme.js';
import { ChatPanel } from './ChatPanel.js';
import { AgentMessage } from './AgentMessage.js';
import type { Message, ToolCall } from '../../types.js';

function stripAnsi(value: string | undefined): string {
  return (value ?? '').replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '');
}

function frame(lastFrame: () => string | undefined): string {
  return stripAnsi(lastFrame());
}

function withTheme(children: React.ReactElement): React.ReactElement {
  return <ThemeContext.Provider value={DEFAULT_THEME}>{children}</ThemeContext.Provider>;
}

function msg(id: string, role: 'user' | 'assistant', content: string): Message {
  return { id, role, content, timestamp: 1 };
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('ChatPanel Ink rendering', () => {
  it('renders the animated welcome when the conversation is empty', () => {
    const view = render(
      withTheme(
        <ChatPanel
          messages={[]}
          terminalWidth={80}
          terminalHeight={24}
          workspace="/tmp/book"
          model="model-x"
          mode="default"
          commandCount={10}
          skillCount={2}
          reducedMotion
        />,
      ),
    );

    const output = frame(view.lastFrame);
    expect(output).toContain('BOOK');
    expect(output).toContain('Your coding workspace, indexed.');
    expect(output).toContain('/init');
  });

  it('renders a submitted user message, assistant placeholder, then streamed text without overwriting older messages', () => {
    const baseMessages = [
      msg('u0', 'user', 'older question'),
      msg('a0', 'assistant', 'older answer'),
      msg('u1', 'user', 'new question'),
      msg('a1', 'assistant', ''),
    ];

    const view = render(
      withTheme(
        <ChatPanel
          messages={baseMessages}
          streamingMessageId="a1"
          terminalWidth={100}
          reducedMotion
          screenReader
        />,
      ),
    );

    expect(frame(view.lastFrame)).toContain('██████');
    expect(frame(view.lastFrame)).not.toContain('Your coding workspace, indexed.');
    expect(frame(view.lastFrame)).toContain('older question');
    expect(frame(view.lastFrame)).toContain('older answer');
    expect(frame(view.lastFrame)).toContain('new question');

    view.rerender(
      withTheme(
        <ChatPanel
          messages={baseMessages.map((message) =>
            message.id === 'a1' ? { ...message, content: 'streamed reply' } : message,
          )}
          streamingMessageId="a1"
          terminalWidth={100}
          reducedMotion
          screenReader
        />,
      ),
    );

    const output = frame(view.lastFrame);
    expect(output).toContain('older question');
    expect(output).toContain('older answer');
    expect(output).toContain('new question');
    expect(output).toContain('streamed reply');
  });

  it('hands a wrapped response from dynamic output to Static without duplicating its suffix', async () => {
    const marker = 'UNIQUE_FINAL_SUFFIX_42';
    const messages = [
      msg('u1', 'user', 'write a long answer'),
      msg('a1', 'assistant', `${'wrapped response content '.repeat(16)}\n${marker}`),
    ];

    const view = render(
      withTheme(
        <ChatPanel
          messages={messages}
          streamingMessageId="a1"
          terminalWidth={48}
          reducedMotion
          screenReader
        />,
      ),
    );

    const streamingFrame = frame(view.lastFrame);
    expect(streamingFrame).toContain(marker);
    const beforeCompletion = view.frames.length;

    view.rerender(
      withTheme(
        <ChatPanel
          messages={messages}
          streamingMessageId={null}
          terminalWidth={48}
          reducedMotion
          screenReader
        />,
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, 75));

    const transitionFrames = view.frames.slice(beforeCompletion).map(stripAnsi);
    expect(transitionFrames.length).toBeGreaterThanOrEqual(2);
    expect(transitionFrames.some((output) => !output.includes(marker))).toBe(true);
    expect(frame(view.lastFrame)).toContain(marker);
  });

  it('queues rapid streaming handoffs and commits them in order', async () => {
    vi.useFakeTimers();
    const messagesA = [msg('a1', 'assistant', 'MARKER_A')];
    const view = render(
      withTheme(
        <ChatPanel
          messages={messagesA}
          streamingMessageId="a1"
          terminalWidth={50}
          reducedMotion
          screenReader
        />,
      ),
    );

    const messagesB = [...messagesA, msg('a2', 'assistant', 'MARKER_B')];
    view.rerender(
      withTheme(
        <ChatPanel
          messages={messagesB}
          streamingMessageId="a2"
          terminalWidth={50}
          reducedMotion
          screenReader
        />,
      ),
    );
    const messagesC = [...messagesB, msg('a3', 'assistant', 'MARKER_C')];
    view.rerender(
      withTheme(
        <ChatPanel
          messages={messagesC}
          streamingMessageId="a3"
          terminalWidth={50}
          reducedMotion
          screenReader
        />,
      ),
    );

    expect(frame(view.lastFrame)).not.toContain('MARKER_A');
    expect(frame(view.lastFrame)).not.toContain('MARKER_B');
    expect(frame(view.lastFrame)).toContain('MARKER_C');

    await act(async () => vi.advanceTimersByTime(55));
    expect(frame(view.lastFrame)).toContain('MARKER_A');
    expect(frame(view.lastFrame)).not.toContain('MARKER_B');
    expect(frame(view.lastFrame)).toContain('MARKER_C');

    await act(async () => vi.advanceTimersByTime(55));
    expect(frame(view.lastFrame)).toContain('MARKER_A');
    expect(frame(view.lastFrame)).toContain('MARKER_B');
    expect(frame(view.lastFrame)).toContain('MARKER_C');
  });

  it('keeps the previous turn completed while a new assistant turn starts streaming', async () => {
    const previousMarker = 'PREVIOUS_TURN_SUFFIX';
    const activeMarker = 'ACTIVE_TURN_TEXT';
    const previousMessages = [
      msg('u1', 'user', 'inspect the project'),
      msg('a1', 'assistant', `${'completed wrapped text '.repeat(10)}${previousMarker}`),
    ];

    const view = render(
      withTheme(
        <ChatPanel
          messages={previousMessages}
          streamingMessageId="a1"
          terminalWidth={50}
          reducedMotion
          screenReader
          retryPhase="transport"
          retryAttempt={2}
          retryMax={5}
          retryCountdownMs={4_000}
        />,
      ),
    );

    view.rerender(
      withTheme(
        <ChatPanel
          messages={[...previousMessages, msg('a2', 'assistant', activeMarker)]}
          streamingMessageId="a2"
          terminalWidth={50}
          reducedMotion
          screenReader
          retryPhase="transport"
          retryAttempt={2}
          retryMax={5}
          retryCountdownMs={4_000}
        />,
      ),
    );

    const handoffFrame = frame(view.lastFrame);
    expect(handoffFrame).not.toContain(previousMarker);
    expect(handoffFrame).toContain(activeMarker);

    await new Promise((resolve) => setTimeout(resolve, 75));
    const committedFrame = frame(view.lastFrame);
    expect(committedFrame).toContain(previousMarker);
    expect(committedFrame).toContain(activeMarker);
  });

  it('renders tool calls and results under the assistant turn that produced them', () => {
    const messages: Message[] = [
      msg('u1', 'user', 'inspect file'),
      {
        ...msg('a1', 'assistant', 'I will inspect it.'),
        toolCalls: [{ id: 'call-1', name: 'Read', arguments: { filePath: 'src/a.ts' } }],
        toolResults: [{ toolCallId: 'call-1', success: true, output: 'file contents' }],
      },
      msg('a2', 'assistant', 'The file looks good.'),
    ];

    const view = render(
      withTheme(
        <ChatPanel
          messages={messages}
          activeToolCallId="call-1"
          terminalWidth={100}
          reducedMotion
          screenReader
        />,
      ),
    );

    const output = frame(view.lastFrame);
    expect(output).toContain('I will inspect it.');
    expect(output).toContain('[OK] Read file src/a.ts');
    expect(output).toContain('file contents');
    expect(output).toContain('The file looks good.');
    expect(output.indexOf('[OK] Read file src/a.ts')).toBeGreaterThan(
      output.indexOf('I will inspect it.'),
    );
    expect(output.indexOf('[OK] Read file src/a.ts')).toBeLessThan(
      output.indexOf('The file looks good.'),
    );
  });

  it('renders a pending permission prompt inside the matching assistant message', () => {
    const toolCall: ToolCall = {
      id: 'call-pending',
      name: 'Bash',
      arguments: { command: 'npm test' },
    };
    const onResolve = vi.fn();
    const messages: Message[] = [
      msg('u1', 'user', 'run tests'),
      { ...msg('a1', 'assistant', 'I need to run a command.'), toolCalls: [toolCall] },
    ];

    const view = render(
      withTheme(
        <ChatPanel
          messages={messages}
          pendingPermission={{ toolCall, resolve: onResolve }}
          onResolvePermission={onResolve}
          activeToolCallId="call-pending"
          terminalWidth={100}
          reducedMotion
          screenReader
        />,
      ),
    );

    const output = frame(view.lastFrame);
    expect(output).toContain('I need to run a command.');
    expect(output).toContain('[needs approval]');
    expect(output).toContain('Permission required for: Bash');
    expect(output).toContain('Primary argument: npm test');
    expect(output).toContain('Press: [R] Run once [S] Skip [A] Always allow [Esc] Deny');
  });

  it('keeps a streaming tool-call-only message dynamic so permission prompts can appear', () => {
    const toolCall: ToolCall = {
      id: 'call-streaming-pending',
      name: 'Glob',
      arguments: { pattern: '*.ts' },
    };
    const onResolve = vi.fn();
    const messages: Message[] = [
      msg('u1', 'user', 'inspect files'),
      { ...msg('a1', 'assistant', 'I will inspect the project first.') },
      { ...msg('a2', 'assistant', ''), toolCalls: [toolCall] },
    ];

    const view = render(
      withTheme(
        <ChatPanel
          messages={messages}
          streamingMessageId="a2"
          activeToolCallId="call-streaming-pending"
          terminalWidth={100}
          reducedMotion
          screenReader
        />,
      ),
    );

    expect(frame(view.lastFrame)).not.toContain('Permission required for: Glob');

    view.rerender(
      withTheme(
        <ChatPanel
          messages={messages}
          streamingMessageId="a2"
          pendingPermission={{ toolCall, resolve: onResolve }}
          onResolvePermission={onResolve}
          activeToolCallId="call-streaming-pending"
          terminalWidth={100}
          reducedMotion
          screenReader
        />,
      ),
    );

    const output = frame(view.lastFrame);
    expect(output).toContain('I will inspect the project first.');
    expect(output).toContain('[needs approval]');
    expect(output).toContain('Permission required for: Glob');
    expect(output).toContain('Primary argument: *.ts');
    expect(output).toContain('Press: [R] Run once [S] Skip [A] Always allow [Esc] Deny');
  });

  it('mounts a quiescent plan approval alongside the active message', () => {
    vi.useFakeTimers();
    const toolCall: ToolCall = {
      id: 'call-exit-plan-mode',
      name: 'ExitPlanMode',
      arguments: { plan: 'Step 1: update rendering\nStep 2: run tests' },
    };
    const messages: Message[] = [
      msg('u1', 'user', 'fix plan mode scrolling'),
      { ...msg('a1', 'assistant', 'I found the likely cause.') },
      { ...msg('a2', 'assistant', ''), toolCalls: [toolCall] },
    ];
    const resolve = vi.fn();
    const pendingPlanApproval = {
      plan: 'Step 1: update rendering\nStep 2: run tests',
      resolve,
    };

    const view = render(
      withTheme(
        <ChatPanel
          messages={messages}
          streamingMessageId="a2"
          activeToolCallId="call-exit-plan-mode"
          terminalWidth={100}
          reducedMotion
          screenReader
        />,
      ),
    );

    const outputBeforeApproval = frame(view.lastFrame);
    expect(outputBeforeApproval).toContain('fix plan mode scrolling');
    expect(outputBeforeApproval).toContain('I found the likely cause.');
    expect(outputBeforeApproval).toContain('ExitPlanMode');
    expect(outputBeforeApproval).not.toContain('Plan approval required.');

    view.rerender(
      withTheme(
        <ChatPanel
          messages={messages}
          streamingMessageId="a2"
          pendingPlanApproval={pendingPlanApproval}
          onResolvePlanApproval={resolve}
          activeToolCallId="call-exit-plan-mode"
          terminalWidth={100}
          screenReader
        />,
      ),
    );

    const outputDuringApproval = frame(view.lastFrame);
    const writesDuringApproval = view.frames.length;
    expect(outputDuringApproval).toContain('fix plan mode scrolling');
    expect(outputDuringApproval).toContain('I found the likely cause.');
    expect(outputDuringApproval).toContain('ExitPlanMode');
    expect(outputDuringApproval).toContain('Plan approval required');
    expect(outputDuringApproval).toContain('Step 1: update rendering');
    expect(outputDuringApproval).toContain('Step 2: run tests');
    expect(outputDuringApproval).toContain('Press: [A] Approve [R] Reject [Esc] Reject');

    act(() => {
      vi.advanceTimersByTime(800);
    });
    expect(view.frames).toHaveLength(writesDuringApproval);

    view.stdin.write('a');
    expect(resolve).toHaveBeenCalledOnce();
    expect(resolve).toHaveBeenCalledWith('approve');

    view.rerender(
      withTheme(
        <ChatPanel
          messages={messages}
          streamingMessageId="a2"
          activeToolCallId="call-exit-plan-mode"
          terminalWidth={100}
          reducedMotion
          screenReader
        />,
      ),
    );

    const outputAfterApproval = frame(view.lastFrame);
    expect(outputAfterApproval).toContain('fix plan mode scrolling');
    expect(outputAfterApproval).toContain('I found the likely cause.');
    expect(outputAfterApproval).toContain('ExitPlanMode');
    expect(outputAfterApproval).not.toContain('Plan approval required');
  });

  it('merges a tool-call-only assistant message after streaming completes', () => {
    const messages: Message[] = [
      msg('u1', 'user', 'inspect files'),
      { ...msg('a1', 'assistant', 'I will inspect the project first.') },
      {
        ...msg('a2', 'assistant', ''),
        toolCalls: [{ id: 'call-merged', name: 'Glob', arguments: { pattern: '*.ts' } }],
        toolResults: [{ toolCallId: 'call-merged', success: true, output: 'src/index.ts' }],
      },
    ];

    const view = render(
      withTheme(
        <ChatPanel
          messages={messages}
          activeToolCallId="call-merged"
          terminalWidth={100}
          reducedMotion
          screenReader
        />,
      ),
    );

    const output = frame(view.lastFrame);
    expect(output).toContain('I will inspect the project first.');
    expect(output).toContain('[OK] Find files *.ts');
    expect(output.indexOf('I will inspect the project first.')).toBeLessThan(
      output.indexOf('[OK] Find files *.ts'),
    );
  });

  it('renders retry and stall labels on AgentMessage when inline activity is enabled', () => {
    const stalled = render(
      withTheme(
        <AgentMessage
          message={msg('a1', 'assistant', '')}
          isStreaming
          reducedMotion
          retryPhase="stalled"
          retryCountdownMs={20_000}
        />,
      ),
    );

    expect(frame(stalled.lastFrame)).toContain(
      'Retrying: Waiting for API response · will retry in 20s · check your network',
    );
    stalled.unmount();

    const retrying = render(
      withTheme(
        <AgentMessage
          message={msg('a2', 'assistant', 'partial text')}
          isStreaming
          reducedMotion
          retryPhase="transport"
          retryAttempt={2}
          retryMax={10}
          retryCountdownMs={4_000}
        />,
      ),
    );

    expect(frame(retrying.lastFrame)).toContain('Retrying: Retrying in 4s · attempt 2/10');
    expect(frame(retrying.lastFrame)).toContain('partial text');
  });

  it('hides active message spinner when external working indicator owns activity state', () => {
    const view = render(
      withTheme(
        <ChatPanel
          messages={[msg('a1', 'assistant', 'partial text')]}
          streamingMessageId="a1"
          terminalWidth={100}
          reducedMotion
          retryPhase="transport"
          retryAttempt={2}
          retryMax={10}
          retryCountdownMs={4_000}
        />,
      ),
    );

    const output = frame(view.lastFrame);
    expect(output).toContain('partial text');
    expect(output).not.toContain('Retrying:');
    expect(output).not.toContain('Retrying in 4s');
  });

  it('collapses long tool output under the assistant turn by default', () => {
    const longOutput = Array.from({ length: 8 }, (_, i) => `line ${i + 1}`).join('\n');
    const messages: Message[] = [
      {
        ...msg('a1', 'assistant', 'I will run it.'),
        toolCalls: [{ id: 'call-1', name: 'Bash', arguments: { command: 'seq 8' } }],
        toolResults: [{ toolCallId: 'call-1', success: true, output: longOutput }],
      },
    ];

    const view = render(
      withTheme(
        <ChatPanel
          messages={messages}
          activeToolCallId="call-1"
          terminalWidth={100}
          reducedMotion
        />,
      ),
    );

    const output = frame(view.lastFrame);
    expect(output).toContain('line 1');
    expect(output).toContain('line 5');
    expect(output).not.toContain('line 6');
    expect(output).toContain('3 more lines hidden');
  });

  it('renders long tool output when show-all mode is enabled', () => {
    const longOutput = Array.from({ length: 8 }, (_, i) => `line ${i + 1}`).join('\n');
    const messages: Message[] = [
      {
        ...msg('a1', 'assistant', 'I will run it.'),
        toolCalls: [{ id: 'call-1', name: 'Bash', arguments: { command: 'seq 8' } }],
        toolResults: [{ toolCallId: 'call-1', success: true, output: longOutput }],
      },
    ];

    const view = render(
      withTheme(
        <ChatPanel
          messages={messages}
          activeToolCallId="call-1"
          terminalWidth={100}
          reducedMotion
          showAllToolOutput
        />,
      ),
    );

    const output = frame(view.lastFrame);
    expect(output).toContain('line 8');
    expect(output).not.toContain('more lines hidden');
  });

  it('renders Claude-style file mutation metadata under the assistant turn', () => {
    const diffOutput = ['@@ -1 +1 @@', '-old line', '+new line'].join('\n');
    const messages: Message[] = [
      {
        ...msg('a1', 'assistant', 'I will update it.'),
        toolCalls: [{ id: 'call-1', name: 'Edit', arguments: { filePath: 'src/a.ts' } }],
        toolResults: [
          {
            toolCallId: 'call-1',
            success: true,
            output: diffOutput,
            fileMutation: {
              kind: 'update',
              filePath: 'src/a.ts',
              addedLines: 1,
              removedLines: 1,
            },
          },
        ],
      },
    ];

    const view = render(
      withTheme(
        <ChatPanel
          messages={messages}
          activeToolCallId="call-1"
          terminalWidth={100}
          reducedMotion
        />,
      ),
    );

    const output = frame(view.lastFrame);
    expect(output).toContain('I will update it.');
    expect(output).toContain('Update(src/a.ts)');
    expect(output).toContain('Added 1 line, removed 1 line');
    expect(output).toContain('-old line');
    expect(output).toContain('+new line');
  });

  it('merges adjacent assistant messages where later has no content (tool-call-only turn)', () => {
    const messages: Message[] = [
      msg('u1', 'user', 'run tests'),
      {
        ...msg('a1', 'assistant', 'I will explore the project.'),
        toolCalls: [{ id: 'call-1', name: 'Glob', arguments: { pattern: '*.ts' } }],
        toolResults: [{ toolCallId: 'call-1', success: true, output: 'src/index.ts' }],
      },
      // Tool-call-only turn — no content, just tool calls/results.
      {
        ...msg('a2', 'assistant', ''),
        toolCalls: [{ id: 'call-2', name: 'Read', arguments: { filePath: 'src/index.ts' } }],
        toolResults: [{ toolCallId: 'call-2', success: true, output: 'file contents' }],
      },
      // Another tool-call-only turn.
      {
        ...msg('a3', 'assistant', ''),
        toolCalls: [{ id: 'call-3', name: 'Grep', arguments: { pattern: 'export' } }],
        toolResults: [{ toolCallId: 'call-3', success: true, output: '1 match' }],
      },
    ];

    const view = render(
      withTheme(
        <ChatPanel
          messages={messages}
          activeToolCallId="call-1"
          terminalWidth={100}
          reducedMotion
          screenReader
        />,
      ),
    );

    const output = frame(view.lastFrame);
    // All tool calls should appear under a single "I will explore the project" block.
    // No repeated empty "Book" headers between tools.
    expect(output).toContain('I will explore the project.');
    expect(output).toContain('[OK] Find files *.ts');
    expect(output).toContain('[OK] Read file src/index.ts');
    expect(output).toContain('[OK] Search files');

    // The tool calls should appear in order after the text.
    const textIdx = output.indexOf('I will explore the project.');
    const globIdx = output.indexOf('[OK] Find files');
    const readIdx = output.indexOf('[OK] Read file');
    const grepIdx = output.indexOf('[OK] Search files');
    expect(textIdx).toBeLessThan(globIdx);
    expect(globIdx).toBeLessThan(readIdx);
    expect(readIdx).toBeLessThan(grepIdx);
  });
});
