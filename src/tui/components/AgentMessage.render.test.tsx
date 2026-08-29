import { afterEach, describe, expect, it } from 'vitest';
import { render, cleanup } from 'ink-testing-library';
import { ThemeContext, DEFAULT_THEME } from '../theme.js';
import { AgentMessage } from './AgentMessage.js';
import type { Message } from '../../types/messages.js';

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
