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
});

describe('ChatPanel Ink rendering', () => {
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
          maxHeight={40}
          terminalWidth={100}
          reducedMotion
          screenReader
        />,
      ),
    );

    expect(frame(view.lastFrame)).toContain('older question');
    expect(frame(view.lastFrame)).toContain('older answer');
    expect(frame(view.lastFrame)).toContain('new question');
    expect(frame(view.lastFrame)).toContain('Book');

    view.rerender(
      withTheme(
        <ChatPanel
          messages={baseMessages.map((message) =>
            message.id === 'a1' ? { ...message, content: 'streamed reply' } : message,
          )}
          streamingMessageId="a1"
          maxHeight={40}
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
          maxHeight={40}
          terminalWidth={100}
          reducedMotion
          screenReader
        />,
      ),
    );

    const output = frame(view.lastFrame);
    expect(output).toContain('I will inspect it.');
    expect(output).toContain('[OK] Read src/a.ts');
    expect(output).toContain('file contents');
    expect(output).toContain('The file looks good.');
    expect(output.indexOf('[OK] Read src/a.ts')).toBeGreaterThan(
      output.indexOf('I will inspect it.'),
    );
    expect(output.indexOf('[OK] Read src/a.ts')).toBeLessThan(
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
          maxHeight={40}
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
    expect(output).toContain('Press: [R] Run [S] Skip [A] Always allow [Esc] Deny');
  });

  it('renders retry and stall labels on the active streaming assistant message', () => {
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

  it('does not mix the streaming tail into a scrolled history viewport', () => {
    const messages = Array.from({ length: 30 }, (_, i) =>
      msg(`m${i}`, i % 2 === 0 ? 'user' : 'assistant', `message ${i}`),
    );

    const view = render(
      withTheme(
        <ChatPanel
          messages={messages}
          streamingMessageId="m29"
          scrollOffset={60}
          autoScroll
          maxHeight={20}
          terminalWidth={80}
          reducedMotion
          screenReader
        />,
      ),
    );

    expect(frame(view.lastFrame)).not.toContain('message 29');

    view.rerender(
      withTheme(
        <ChatPanel
          messages={messages}
          streamingMessageId="m29"
          scrollOffset={60}
          autoScroll={false}
          maxHeight={20}
          terminalWidth={80}
          reducedMotion
          screenReader
        />,
      ),
    );

    expect(frame(view.lastFrame)).not.toContain('message 29');
  });

  it('renders only the visible tail slice of a long clipped message', () => {
    const content = Array.from({ length: 80 }, (_, i) => `row-${String(i).padStart(2, '0')}`).join(
      '\n',
    );

    const view = render(
      withTheme(
        <ChatPanel
          messages={[msg('a1', 'assistant', content)]}
          maxHeight={10}
          terminalWidth={80}
          reducedMotion
          screenReader
        />,
      ),
    );

    const output = frame(view.lastFrame);
    expect(output).not.toContain('row-00');
    expect(output).toContain('row-71');
    expect(output).toContain('row-79');
  });

  it('clips the bottom of the latest text message while scrolling up', () => {
    const content = Array.from({ length: 80 }, (_, i) => `row-${String(i).padStart(2, '0')}`).join(
      '\n',
    );

    const view = render(
      withTheme(
        <ChatPanel
          messages={[msg('a1', 'assistant', content)]}
          scrollOffset={3}
          maxHeight={10}
          terminalWidth={80}
          reducedMotion
          screenReader
        />,
      ),
    );

    const output = frame(view.lastFrame);
    expect(output).toContain('row-77');
    expect(output).not.toContain('row-78');
    expect(output).not.toContain('row-79');
  });
});
