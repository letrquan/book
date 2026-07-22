import { setImmediate as waitForImmediate } from 'node:timers/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from 'ink-testing-library';
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
