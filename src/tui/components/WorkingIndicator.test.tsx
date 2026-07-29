import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from 'ink-testing-library';
import { DEFAULT_THEME, ThemeContext } from '../theme.js';
import { toolActivityText } from '../working-activity.js';
import { WorkingIndicator } from './WorkingIndicator.js';
import type { Message } from '../../types/messages.js';

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

  it('shows an agent-style reasoning phase while busy', () => {
    const view = render(
      withTheme(<WorkingIndicator isThinking messages={[]} terminalWidth={80} reducedMotion />),
    );

    const output = stripAnsi(view.lastFrame());
    expect(output).toContain('Pondering the plot twist');
    expect(output).toContain('Esc to cancel');
  });

  it('shows composing once streamed content exists', () => {
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

    expect(stripAnsi(view.lastFrame())).toContain('Writing the final page');
  });

  it('describes the concrete tool activity and queued calls', () => {
    const messages: Message[] = [
      {
        ...msg('a1', 'assistant', ''),
        toolCalls: [
          { id: 'read-1', name: 'Read', arguments: { file_path: 'src/app.ts' } },
          { id: 'grep-1', name: 'Grep', arguments: { pattern: 'spinner' } },
        ],
      },
    ];
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

    const output = stripAnsi(view.lastFrame());
    expect(output).toContain('src/app.ts');
    expect(output).toContain('1 tool in the');
    expect(output).not.toContain('Waiting for tool response');
  });

  it('prefers live nested tool activity over the parent task', () => {
    const messages: Message[] = [
      {
        ...msg('a1', 'assistant', ''),
        toolCalls: [{ id: 'task-1', name: 'Task', arguments: { subject: 'Inspect UI' } }],
        nestedToolInvocations: [
          {
            traceId: 'nested-1',
            parentTraceId: 'task-1',
            call: { id: 'nested-read', name: 'Read', arguments: { filePath: 'src/theme.ts' } },
          },
        ],
      },
    ];
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

    expect(stripAnsi(view.lastFrame())).toContain('src/theme.ts');
  });

  it('formats built-in, shell, and MCP activity labels', () => {
    expect(toolActivityText({ id: '1', name: 'GitDiff', arguments: {} })).toMatch(
      /red ink|editorial marks|before and after/,
    );
    const shellActivity = toolActivityText({
      id: '2',
      name: 'Bash',
      arguments: { command: 'npm test\nignored' },
    });
    expect(shellActivity).toContain('npm test');
    expect(shellActivity).not.toContain('ignored');

    const mcpActivity = toolActivityText({
      id: '3',
      name: 'mcp__github__get_pull_request',
      arguments: {},
    });
    expect(mcpActivity).toContain('github');
    expect(mcpActivity).toContain('get pull request');
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
          pendingPlanApproval={{ plan: 'Review the changes.' }}
          terminalWidth={80}
        />,
      ),
    );

    const initialFrame = view.lastFrame();
    const initialWriteCount = view.frames.length;
    expect(stripAnsi(initialFrame)).toContain('Waiting for plan approval');
    expect(stripAnsi(initialFrame)).toContain('approve, adjust, or reject');
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
      vi.advanceTimersByTime(100);
    });

    expect(view.lastFrame()).not.toBe(initialFrame);
    expect(view.frames.length).toBeGreaterThan(initialWriteCount);
  });

  it('rotates reasoning phases and shows elapsed time', () => {
    vi.useFakeTimers();
    const view = render(
      withTheme(<WorkingIndicator isThinking messages={[]} terminalWidth={80} />),
    );

    expect(stripAnsi(view.lastFrame())).toContain('Pondering the plot twist · 0s');

    act(() => {
      vi.advanceTimersByTime(3_000);
    });

    expect(stripAnsi(view.lastFrame())).toContain('Consulting the footnotes · 3s');
  });

  it('resets elapsed time when activity resumes after approval', async () => {
    vi.useFakeTimers();
    const view = render(
      withTheme(<WorkingIndicator isThinking messages={[]} terminalWidth={80} />),
    );

    await act(async () => {
      vi.advanceTimersByTime(2_000);
    });
    expect(stripAnsi(view.lastFrame())).toContain('· 2s');

    await view.rerender(
      withTheme(
        <WorkingIndicator
          isThinking
          messages={[]}
          pendingPlanApproval={{ plan: 'Review the changes.' }}
          terminalWidth={80}
        />,
      ),
    );
    await act(async () => {
      vi.advanceTimersByTime(5_000);
    });

    await view.rerender(
      withTheme(<WorkingIndicator isThinking messages={[]} terminalWidth={80} />),
    );
    expect(stripAnsi(view.lastFrame())).toContain('· 0s');
  });

  it('keeps long activity labels on one row in narrow terminals', () => {
    const messages: Message[] = [
      {
        ...msg('a1', 'assistant', ''),
        toolCalls: [
          {
            id: 'grep-1',
            name: 'Grep',
            arguments: { pattern: 'a very long search expression' },
          },
        ],
      },
    ];
    const view = render(
      withTheme(
        <WorkingIndicator
          isThinking
          messages={messages}
          streamingMessageId="a1"
          terminalWidth={20}
          reducedMotion
        />,
      ),
    );

    const output = stripAnsi(view.lastFrame()).trim();
    expect(output).toMatch(/Hunting|Following|Interrogating/);
    expect(output.split('\n')).toHaveLength(1);
  });

  it('caps active compact progress below 100% until compaction succeeds', () => {
    vi.useFakeTimers();
    const view = render(
      withTheme(
        <WorkingIndicator
          isThinking={false}
          isCompacting
          compactTrigger="manual"
          messages={[]}
          terminalWidth={80}
        />,
      ),
    );

    expect(stripAnsi(view.lastFrame())).toContain('Compacting');
    expect(stripAnsi(view.lastFrame())).toContain('0%');
    expect(stripAnsi(view.lastFrame())).toContain('Esc to cancel');

    act(() => {
      vi.advanceTimersByTime(1_200);
    });
    expect(stripAnsi(view.lastFrame())).toContain('50%');

    act(() => {
      vi.advanceTimersByTime(1_200);
    });
    const pending = stripAnsi(view.lastFrame());
    expect(pending).toContain('95%');
    expect(pending).not.toContain('100%');

    view.rerender(
      withTheme(
        <WorkingIndicator
          isThinking={false}
          compactTrigger="manual"
          compactComplete
          messages={[]}
          terminalWidth={80}
        />,
      ),
    );

    const completed = stripAnsi(view.lastFrame());
    expect(completed).toContain('Compacted');
    expect(completed).toContain('100%');
    expect(completed).toContain('████████████████████████');
    expect(completed).not.toContain('Esc to cancel');
  });

  it('keeps compact progress on one row in narrow terminals', () => {
    vi.useFakeTimers();
    const view = render(
      withTheme(
        <WorkingIndicator
          isThinking={false}
          isCompacting
          compactTrigger="manual"
          messages={[]}
          terminalWidth={20}
        />,
      ),
    );

    act(() => {
      vi.advanceTimersByTime(1_200);
    });

    const output = stripAnsi(view.lastFrame());
    expect(output.trim()).toContain('Compact');
    expect(output).toContain('50%');
    expect(output.trim().split('\n')).toHaveLength(1);
  });

  it('does not show completion when compacting stops without success', () => {
    vi.useFakeTimers();
    const view = render(
      withTheme(
        <WorkingIndicator isThinking={false} isCompacting messages={[]} terminalWidth={80} />,
      ),
    );

    act(() => {
      vi.advanceTimersByTime(2_400);
    });
    expect(stripAnsi(view.lastFrame())).toContain('95%');

    view.rerender(
      withTheme(<WorkingIndicator isThinking={false} messages={[]} terminalWidth={80} />),
    );

    expect(stripAnsi(view.lastFrame()).trim()).toBe('');
  });
});
