import { setImmediate as waitForImmediate } from 'node:timers/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from 'ink-testing-library';
import stripAnsi from 'strip-ansi';
import { DEFAULT_THEME, ThemeContext } from '../theme.js';
import { PermissionButtons, toolRiskLevel } from './PermissionButtons.js';

function withTheme(children: React.ReactElement): React.ReactElement {
  return <ThemeContext.Provider value={DEFAULT_THEME}>{children}</ThemeContext.Provider>;
}

afterEach(() => cleanup());

describe('PermissionButtons', () => {
  it('resolves consecutive tool prompts rendered in the same slot', async () => {
    const onResolveRead = vi.fn();
    const onResolveGlob = vi.fn();
    const view = render(
      withTheme(
        <PermissionButtons
          toolCall={{ id: 'read-1', name: 'Read', arguments: { file_path: 'README.md' } }}
          onResolve={onResolveRead}
        />,
      ),
    );

    view.stdin.write('\r');
    await waitForImmediate();

    view.rerender(
      withTheme(
        <PermissionButtons
          toolCall={{ id: 'glob-1', name: 'Glob', arguments: { pattern: '**/*.ts' } }}
          onResolve={onResolveGlob}
        />,
      ),
    );
    await waitForImmediate();
    view.stdin.write('\r');
    await waitForImmediate();

    expect(onResolveRead).toHaveBeenCalledOnce();
    expect(onResolveRead).toHaveBeenCalledWith('allow');
    expect(onResolveGlob).toHaveBeenCalledOnce();
    expect(onResolveGlob).toHaveBeenCalledWith('allow');
  });

  it('resolves only once when multiple approval keys arrive for one tool', () => {
    const onResolve = vi.fn();
    const view = render(
      withTheme(
        <PermissionButtons
          toolCall={{ id: 'read-1', name: 'Read', arguments: { file_path: 'README.md' } }}
          onResolve={onResolve}
        />,
      ),
    );

    view.stdin.write('r');
    view.stdin.write('s');
    view.stdin.write('\r');

    expect(onResolve).toHaveBeenCalledOnce();
    expect(onResolve).toHaveBeenCalledWith('allow');
  });

  // `always` is the only choice here that writes a rule to disk, and nothing in
  // the UI removes one. A lone `a` used to grant it outright: with the composer
  // below still reading "Type a follow-up", one letter of an ordinary sentence
  // persisted a shell allow with no visible trace.
  it('arms "Always allow" on A but does not grant it without a deliberate Enter', () => {
    const onResolve = vi.fn();
    const view = render(
      withTheme(
        <PermissionButtons
          toolCall={{ id: 'bash-1', name: 'Bash', arguments: { command: 'echo one' } }}
          onResolve={onResolve}
        />,
      ),
    );

    view.stdin.write('a');
    expect(onResolve).not.toHaveBeenCalled();

    // Space used to activate too, which left `always` reachable by "a ".
    view.stdin.write(' ');
    expect(onResolve).not.toHaveBeenCalled();

    view.stdin.write('\r');
    expect(onResolve).toHaveBeenCalledOnce();
    // `always` carries the rule, because the ladder means it is not always the
    // exact command.
    expect(onResolve).toHaveBeenCalledWith({ result: 'always', rule: 'Bash(echo one)' });
  });

  // The exact rule matches that byte sequence and nothing else, so a user who
  // pressed "Always allow" to stop being asked was asked again next call.
  it('steps the Always allow scope on repeated A and writes the chosen rule', async () => {
    const onResolve = vi.fn();
    const view = render(
      withTheme(
        <PermissionButtons
          toolCall={{ id: 'bash-3', name: 'Bash', arguments: { command: 'npm run check' } }}
          onResolve={onResolve}
        />,
      ),
    );

    view.stdin.write('a'); // arm
    await waitForImmediate();
    view.stdin.write('a'); // widen once
    await waitForImmediate();
    expect(stripAnsi(view.lastFrame() ?? '')).toContain('Bash(npm run *)');
    expect(onResolve).not.toHaveBeenCalled();

    view.stdin.write('\r');
    expect(onResolve).toHaveBeenCalledExactlyOnceWith({
      result: 'always',
      rule: 'Bash(npm run *)',
    });
  });

  it('wraps back to the exact rule rather than committing one', async () => {
    const onResolve = vi.fn();
    const view = render(
      withTheme(
        <PermissionButtons
          toolCall={{ id: 'bash-4', name: 'Bash', arguments: { command: 'npm run check' } }}
          onResolve={onResolve}
        />,
      ),
    );

    // Arm, then a full cycle back round to the exact rule.
    for (let i = 0; i < 4; i++) {
      view.stdin.write('a');
      await waitForImmediate();
    }
    expect(stripAnsi(view.lastFrame() ?? '')).toContain('Bash(npm run check)');
    expect(onResolve).not.toHaveBeenCalled();
  });

  it('keeps R and S as single-key shortcuts', () => {
    const onResolve = vi.fn();
    const view = render(
      withTheme(
        <PermissionButtons
          toolCall={{ id: 'bash-2', name: 'Bash', arguments: { command: 'echo two' } }}
          onResolve={onResolve}
        />,
      ),
    );

    view.stdin.write('s');
    expect(onResolve).toHaveBeenCalledExactlyOnceWith('deny');
  });
});

describe('toolRiskLevel', () => {
  it('classifies shell tools as shell-risk', () => {
    expect(toolRiskLevel({ id: '1', name: 'Bash', arguments: { command: 'pwd' } })).toBe('shell');
    expect(toolRiskLevel({ id: '2', name: 'BashOutput', arguments: { shell_id: 'shell_1' } })).toBe(
      'shell',
    );
    expect(toolRiskLevel({ id: '3', name: 'KillShell', arguments: { shell_id: 'shell_1' } })).toBe(
      'shell',
    );
  });

  it('classifies file writes separately from safe tools', () => {
    expect(toolRiskLevel({ id: '4', name: 'Write', arguments: { filePath: 'a.txt' } })).toBe(
      'write',
    );
    expect(
      toolRiskLevel({
        id: '5',
        name: 'NotebookEdit',
        arguments: { notebook_path: 'analysis.ipynb' },
      }),
    ).toBe('write');
    expect(toolRiskLevel({ id: '6', name: 'Read', arguments: { filePath: 'a.txt' } })).toBe('safe');
  });
});
