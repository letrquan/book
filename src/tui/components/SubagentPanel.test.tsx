import { cleanup, render } from 'ink-testing-library';
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentSummary } from '../../agents/types.js';
import { DEFAULT_THEME, ThemeContext } from '../theme.js';
import { SubagentPanel } from './SubagentPanel.js';
import { formatElapsedDuration, SubagentRow } from './SubagentRow.js';

afterEach(() => cleanup());

const agent: AgentSummary = {
  agentId: 'a1',
  displayName: 'Trace authentication flow',
  profile: 'explorer',
  status: 'running',
  resolvedModel: 'gateway/fast-model',
  isolation: 'workspace-readonly',
  currentActivity: {
    kind: 'tool',
    label: 'Searching src/auth',
    toolName: 'Grep',
    status: 'running',
    startedAt: 1,
  },
  createdAt: Date.now(),
  updatedAt: Date.now(),
};

describe('SubagentPanel', () => {
  it('renders each task as a compact title and elapsed-time row', () => {
    const view = render(
      <ThemeContext.Provider value={DEFAULT_THEME}>
        <SubagentPanel agents={[agent]} width={100} reducedMotion />
      </ThemeContext.Provider>,
    );
    const output = view.lastFrame() ?? '';
    expect(output).toMatch(/Trace authentication flow \| \d+s/);
    expect(output).not.toContain('explorer');
    expect(output).not.toContain('gateway/fast-model');
    expect(output).not.toContain('Searching src/auth');
    expect(output).toContain('Background tasks');
    expect(output).toContain('main');
  });

  it('uses Claude-style task panel controls to open, stop, and return to main', async () => {
    const onSelect = vi.fn();
    const onOpen = vi.fn();
    const onClose = vi.fn();
    const onCancel = vi.fn();
    const onStopOrDismiss = vi.fn();
    const view = render(
      <ThemeContext.Provider value={DEFAULT_THEME}>
        <SubagentPanel
          agents={[agent]}
          width={80}
          reducedMotion
          isActive
          onSelect={onSelect}
          onOpen={onOpen}
          onClose={onClose}
          onCancel={onCancel}
          onStopOrDismiss={onStopOrDismiss}
        />
      </ThemeContext.Provider>,
    );

    view.stdin.write('\x1b[B');
    await vi.waitFor(() => expect(onSelect).toHaveBeenLastCalledWith('a1'));
    view.stdin.write('\r');
    await vi.waitFor(() => expect(onOpen).toHaveBeenCalledWith('a1'));
    view.stdin.write('x');
    await vi.waitFor(() => expect(onStopOrDismiss).toHaveBeenCalledWith('a1'));
    view.stdin.write('\x1b');
    await vi.waitFor(() => expect(onCancel).toHaveBeenCalled());
  });

  it('advances selection with Tab in the active panel', async () => {
    const onSelect = vi.fn();
    const view = render(
      <ThemeContext.Provider value={DEFAULT_THEME}>
        <SubagentPanel agents={[agent]} width={80} reducedMotion isActive onSelect={onSelect} />
      </ThemeContext.Provider>,
    );

    view.stdin.write('\t');
    await vi.waitFor(() => expect(onSelect).toHaveBeenLastCalledWith('a1'));
  });

  it('keeps the focused agent visible when the list overflows the window', () => {
    const many: AgentSummary[] = Array.from({ length: 8 }, (_, index) => ({
      ...agent,
      agentId: `a${index}`,
      displayName: `Agent number ${index}`,
      updatedAt: Date.now() - index,
    }));
    const view = render(
      <ThemeContext.Provider value={DEFAULT_THEME}>
        <SubagentPanel agents={many} width={100} reducedMotion selectedAgentId="a7" />
      </ThemeContext.Provider>,
    );
    const output = view.lastFrame() ?? '';
    expect(output).toContain('Agent number 7');
  });

  it('keeps the purpose visible in tiny mode', () => {
    const view = render(
      <ThemeContext.Provider value={DEFAULT_THEME}>
        <SubagentPanel agents={[agent, { ...agent, agentId: 'a2' }]} width={36} reducedMotion />
      </ThemeContext.Provider>,
    );
    const output = view.lastFrame() ?? '';
    expect(output).toContain('Trace authentication');
    expect(output).toMatch(/\| \d+s/);
    expect(output).toContain('+1 more tasks');
  });

  it('returns to main when the detail picker opens with main selected', async () => {
    const onClose = vi.fn();
    const view = render(
      <ThemeContext.Provider value={DEFAULT_THEME}>
        <SubagentPanel agents={[agent]} isActive onClose={onClose} reducedMotion />
      </ThemeContext.Provider>,
    );

    expect(view.lastFrame()).toContain('› ● main');
    view.stdin.write('\r');
    await vi.waitFor(() => expect(onClose).toHaveBeenCalledOnce());
  });

  it('freezes terminal duration on the task title row', () => {
    const view = render(
      <ThemeContext.Provider value={DEFAULT_THEME}>
        <SubagentRow
          agent={{
            ...agent,
            status: 'completed',
            summary: 'Found the lifecycle gap',
            startedAt: 1000,
            finishedAt: 6000,
            currentActivity: {
              kind: 'thinking',
              label: 'Thinking',
              status: 'running',
              startedAt: 2000,
            },
          }}
          width={100}
          now={50_000}
          reducedMotion
        />
      </ThemeContext.Provider>,
    );
    const output = view.lastFrame() ?? '';
    expect(output).toContain('Trace authentication flow | 5s');
    expect(output).not.toContain('Found the lifecycle gap');
    expect(output).not.toContain('Thinking');
  });

  it('formats elapsed time as minutes and seconds', () => {
    expect(formatElapsedDuration(62)).toBe('1m 2s');
    expect(formatElapsedDuration(3_723)).toBe('1h 2m 3s');
  });

  it('updates running elapsed time without a parent event', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    try {
      const view = render(
        <ThemeContext.Provider value={DEFAULT_THEME}>
          <SubagentRow
            agent={{ ...agent, startedAt: 1_000, createdAt: 1_000 }}
            width={100}
            reducedMotion
          />
        </ThemeContext.Provider>,
      );
      expect(view.lastFrame()).toContain('0s');
      act(() => {
        vi.advanceTimersByTime(62_000);
      });
      expect(view.lastFrame()).toContain('1m 2s');
    } finally {
      vi.useRealTimers();
    }
  });
});
