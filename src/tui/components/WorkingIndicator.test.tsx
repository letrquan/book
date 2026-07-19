import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
  return { id, role, content, includeInContext: true, timestamp: 1 };
}

beforeEach(() => {
  vi.useRealTimers();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('WorkingIndicator', () => {
  it('renders nothing while idle', () => {
    const view = render(
      withTheme(
        <WorkingIndicator isThinking={false} messages={[]} terminalWidth={80} reducedMotion />,
      ),
    );

    expect(stripAnsi(view.lastFrame()).trim()).toBe('');
  });

  it('shows a quiet thinking line while busy', () => {
    const view = render(
      withTheme(<WorkingIndicator isThinking messages={[]} terminalWidth={80} reducedMotion />),
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

  it('keeps the plan approval wait static when motion is enabled', () => {
    vi.useFakeTimers();
    const view = render(
      withTheme(
        <WorkingIndicator
          isThinking
          messages={[]}
          pendingPlanApproval={{ plan: 'Review the changes.', resolve: vi.fn() }}
          terminalWidth={80}
        />,
      ),
    );

    const initialFrame = view.lastFrame();
    const initialWriteCount = view.frames.length;
    expect(stripAnsi(initialFrame)).toContain('Waiting for plan approval');
    expect(stripAnsi(initialFrame)).toContain('Esc to reject');
    expect(stripAnsi(initialFrame)).not.toContain('Esc to cancel');

    act(() => {
      vi.advanceTimersByTime(800);
    });

    expect(view.lastFrame()).toBe(initialFrame);
    expect(view.frames).toHaveLength(initialWriteCount);
  });

  it('continues animating during ordinary thinking', () => {
    vi.useFakeTimers();
    const view = render(
      withTheme(<WorkingIndicator isThinking messages={[]} terminalWidth={80} />),
    );

    const initialFrame = view.lastFrame();
    const initialWriteCount = view.frames.length;

    act(() => {
      vi.advanceTimersByTime(80);
    });

    expect(view.lastFrame()).not.toBe(initialFrame);
    expect(view.frames.length).toBeGreaterThan(initialWriteCount);
  });
});
