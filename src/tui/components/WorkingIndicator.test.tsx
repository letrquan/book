import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from 'ink-testing-library';
import { DEFAULT_THEME, ThemeContext } from '../theme.js';
import { WorkingIndicator } from './WorkingIndicator.js';
import type { Message } from '../../types.js';

function stripAnsi(value: string | undefined): string {
  return (value ?? '').replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '');
}

function withTheme(children: React.ReactElement): React.ReactElement {
  return <ThemeContext.Provider value={DEFAULT_THEME}>{children}</ThemeContext.Provider>;
}

function msg(id: string, role: 'user' | 'assistant', content: string): Message {
  return { id, role, content, timestamp: 1 };
}

afterEach(() => cleanup());

describe('WorkingIndicator', () => {
  it('renders nothing while idle', () => {
    const view = render(
      withTheme(
        <WorkingIndicator
          isThinking={false}
          messages={[]}
          terminalWidth={80}
          reducedMotion
        />,
      ),
    );

    expect(stripAnsi(view.lastFrame()).trim()).toBe('');
  });

  it('shows an opencode-style thinking line while busy', () => {
    const view = render(
      withTheme(
        <WorkingIndicator
          isThinking
          messages={[]}
          terminalWidth={80}
          reducedMotion
        />,
      ),
    );

    const output = stripAnsi(view.lastFrame());
    expect(output).toContain('Thinking');
    expect(output).toContain('Esc to cancel');
  });

  it('shows generating once streamed content exists', () => {
    const messages = [msg('a1', 'assistant', 'partial response')];
    const view = render(
      withTheme(
        <WorkingIndicator
          isThinking
          messages={messages}
          streamingMessageId="a1"
          terminalWidth={80}
          reducedMotion
        />,
      ),
    );

    expect(stripAnsi(view.lastFrame())).toContain('Generating');
  });

  it('shows retry countdown instead of generic thinking text', () => {
    const view = render(
      withTheme(
        <WorkingIndicator
          isThinking
          messages={[]}
          retryPhase="transport"
          retryAttempt={2}
          retryMax={5}
          retryCountdownMs={3_200}
          terminalWidth={80}
          reducedMotion
        />,
      ),
    );

    expect(stripAnsi(view.lastFrame())).toContain('Retrying in 4s · attempt 2/5');
  });
});
