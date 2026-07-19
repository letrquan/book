import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from 'ink-testing-library';
import type { ContextCommandDisplay, UsageCommandDisplay } from '../../types.js';
import { DEFAULT_THEME, ThemeContext } from '../theme.js';
import { CommandPanel, flattenConfigSnapshot } from './CommandPanel.js';
import { displayWidth } from './word-wrap.js';

function stripAnsi(value: string | undefined): string {
  return (value ?? '').replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '');
}

function withTheme(children: React.ReactElement): React.ReactElement {
  return <ThemeContext.Provider value={DEFAULT_THEME}>{children}</ThemeContext.Provider>;
}

const usageDisplay: UsageCommandDisplay = {
  kind: 'usage',
  model: 'claude-sonnet-5',
  currentTurn: 4,
  messageCount: 11,
  turnDurationMs: 2400,
  usage: { promptTokens: 10_000, completionTokens: 2_000, totalTokens: 12_000 },
  rate: { inputPerMillion: 3, outputPerMillion: 15 },
  estimatedCostUsd: 0.06,
};

const contextDisplay: ContextCommandDisplay = {
  kind: 'context',
  model: 'claude-sonnet-5',
  maxTokens: 128_000,
  estimatedTokens: 32_000,
  totalMessages: 12,
  userMessages: 6,
  assistantMessages: 6,
  toolCalls: 8,
  toolResults: 7,
  userTokens: 8_000,
  assistantTokens: 24_000,
  ambient: {
    commandCount: 24,
    skillCount: 3,
    subagentCount: 1,
    hasMemoryIndex: true,
    hasClaudeMdLoader: false,
  },
};

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('CommandPanel', () => {
  it('flattens nested configuration without dropping leaf values', () => {
    expect(
      flattenConfigSnapshot({
        model: 'book/model',
        memory: { enabled: true },
        directories: ['src', 'docs'],
      }),
    ).toEqual([
      { path: 'model', value: 'book/model' },
      { path: 'memory.enabled', value: 'true' },
      { path: 'directories', value: 'src, docs' },
    ]);
  });

  it('renders usage as a soft editorial panel with token traffic', () => {
    const view = render(
      withTheme(
        <CommandPanel
          display={usageDisplay}
          fallback="Session usage"
          terminalWidth={80}
          reducedMotion
        />,
      ),
    );

    const output = stripAnsi(view.lastFrame());
    expect(output).toContain('/usage · Session telemetry');
    expect(output).toContain('ready');
    expect(output).toContain('token traffic');
    expect(output).toContain('input 10,000');
    expect(output).toContain('output 2,000');
    expect(output).toContain('$0.0600');
  });

  it('keeps the context panel inside a narrow terminal', () => {
    const view = render(
      withTheme(
        <CommandPanel
          display={contextDisplay}
          fallback="Context window breakdown"
          terminalWidth={36}
          reducedMotion
        />,
      ),
    );

    const output = stripAnsi(view.lastFrame());
    expect(output).toContain('conversation pressure');
    expect(output).toContain('25%');
    for (const line of output.split('\n')) {
      expect(displayWidth(line)).toBeLessThanOrEqual(36);
    }
  });

  it('uses the plain report in screen-reader mode', () => {
    const fallback = 'Context window breakdown\nConversation total: 12';
    const view = render(
      withTheme(
        <CommandPanel
          display={contextDisplay}
          fallback={fallback}
          terminalWidth={80}
          screenReader
        />,
      ),
    );

    const output = stripAnsi(view.lastFrame());
    expect(output).toContain(fallback);
    expect(output).not.toContain('Window map');
  });

  it('runs a one-shot reading state before settling', () => {
    vi.useFakeTimers();
    const view = render(
      withTheme(
        <CommandPanel display={usageDisplay} fallback="Session usage" terminalWidth={80} />,
      ),
    );

    const initialFrames = view.frames.length;
    expect(stripAnsi(view.lastFrame())).toContain('reading');

    act(() => {
      vi.advanceTimersByTime(700);
    });

    expect(stripAnsi(view.lastFrame())).toContain('ready');
    expect(view.frames.length).toBeGreaterThan(initialFrames);
  });
});
