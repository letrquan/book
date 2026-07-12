import { setImmediate as waitForImmediate } from 'node:timers/promises';
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
    await waitForImmediate();

    expect(onResolve).toHaveBeenCalledOnce();
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
    expect(output).toContain('· 2 steps');
    expect(output).toContain('1. Nested');
  });
});
