import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from 'ink-testing-library';
import { DEFAULT_THEME, ThemeContext } from '../theme.js';
import { PlanApprovalButtons } from './PlanApprovalButtons.js';

function withTheme(children: React.ReactElement): React.ReactElement {
  return <ThemeContext.Provider value={DEFAULT_THEME}>{children}</ThemeContext.Provider>;
}

function stripAnsi(value: string | undefined): string {
  return (value ?? '').replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '');
}

afterEach(() => cleanup());

describe('PlanApprovalButtons', () => {
  it('rejects with Escape', async () => {
    const onResolve = vi.fn();
    const view = render(
      withTheme(<PlanApprovalButtons plan="Review the proposed changes." onResolve={onResolve} />),
    );

    view.stdin.write('\x1b');
    await vi.waitFor(() => expect(onResolve).toHaveBeenCalledOnce());
    expect(onResolve).toHaveBeenCalledWith('reject');
  });

  it('resolves only once when multiple approval keys arrive', () => {
    const onResolve = vi.fn();
    const view = render(
      withTheme(<PlanApprovalButtons plan="Review the proposed changes." onResolve={onResolve} />),
    );

    view.stdin.write('a');
    view.stdin.write('r');
    view.stdin.write('\r');

    expect(onResolve).toHaveBeenCalledOnce();
    expect(onResolve).toHaveBeenCalledWith('approve');
  });

  it('resolves approve-fresh with the F shortcut', () => {
    const onResolve = vi.fn();
    const view = render(
      withTheme(<PlanApprovalButtons plan="Review the proposed changes." onResolve={onResolve} />),
    );

    view.stdin.write('f');

    expect(onResolve).toHaveBeenCalledOnce();
    expect(onResolve).toHaveBeenCalledWith('approve-fresh');
  });

  it('offers the fresh-context approval option', () => {
    const view = render(
      withTheme(<PlanApprovalButtons plan="Review the proposed changes." onResolve={vi.fn()} />),
    );

    const output = stripAnsi(view.lastFrame());
    expect(output).toContain('Approve, fresh context');
    // The shortcut key is set beside what the choice does.
    expect(output).toMatch(/Approve, fresh context\s+F\s+implement it clean/);
  });

  it('collects feedback when the user requests plan adjustments', async () => {
    const onResolve = vi.fn();
    const view = render(
      withTheme(<PlanApprovalButtons plan="Review the proposed changes." onResolve={onResolve} />),
    );

    // Each key waits for the frame it produced. A fixed sleep is a race with the
    // render, and on a loaded runner the composer can still be closed when the
    // feedback is typed, or unanswered when Enter arrives.
    view.stdin.write('e');
    await vi.waitFor(() => expect(stripAnsi(view.lastFrame())).toContain('Adjust the plan'));

    view.stdin.write('Keep the migration backward compatible.');
    await vi.waitFor(() =>
      expect(stripAnsi(view.lastFrame())).toContain('Keep the migration backward compatible.'),
    );
    view.stdin.write('\r');
    await vi.waitFor(() => expect(onResolve).toHaveBeenCalledOnce());

    expect(onResolve).toHaveBeenCalledWith({
      decision: 'revise',
      feedback: 'Keep the migration backward compatible.',
    });
  });

  it('renders markdown tables inside the proposed plan', () => {
    const view = render(
      withTheme(
        <PlanApprovalButtons
          plan={'| Agent | Work |\n|---|---|\n| **Book** | Review |'}
          terminalWidth={40}
          onResolve={vi.fn()}
        />,
      ),
    );

    const output = stripAnsi(view.lastFrame());
    expect(output).toContain('━');
    expect(output).toContain('Book');
    expect(output).not.toContain('**Book**');
  });

  it('strips indented heading markers and counts only top-level steps', () => {
    const view = render(
      withTheme(
        <PlanApprovalButtons
          plan={'  ### Details\n1. First\n   1. Nested\n2) Second'}
          onResolve={vi.fn()}
        />,
      ),
    );

    const output = stripAnsi(view.lastFrame());
    expect(output).toContain('  Details');
    expect(output).not.toContain('### Details');
    expect(output).toContain('2 steps · awaiting approval');
    expect(output).toContain('1. Nested');
  });

  it('resolves the button armed by an arrow in the same batch', async () => {
    const onResolve = vi.fn();
    const view = render(
      withTheme(<PlanApprovalButtons plan="Review the proposed changes." onResolve={onResolve} />),
    );

    // Ink splits a stdin chunk only at escape bytes, so this single write is
    // genuinely two keypresses inside one React batch — a paste, or an arrow
    // repeating faster than a frame. It is the case a per-keypress test cannot
    // reach.
    view.stdin.write('\u001b[C\r');
    await vi.waitFor(() => expect(onResolve).toHaveBeenCalledWith('approve-fresh'));
  });
});
