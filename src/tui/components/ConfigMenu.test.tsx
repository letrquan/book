import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from 'ink-testing-library';
import { DEFAULT_THEME, ThemeContext } from '../theme.js';
import { ConfigMenu } from './ConfigMenu.js';

afterEach(cleanup);

function stripAnsi(value: string | undefined): string {
  return (value ?? '').replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '');
}

describe('ConfigMenu', () => {
  it('opens subagent settings from the keyboard shortcut', () => {
    const onOpen = vi.fn();
    const view = render(
      <ThemeContext.Provider value={DEFAULT_THEME}>
        <ConfigMenu
          model="9router/qc/qwen3.7-max"
          compactModel="9router/ag/gemini-3.6-flash-high"
          effort="high"
          themeName="dark"
          memoryAutoSave={false}
          showThinking
          agentCount={3}
          defaultPermissionMode="default"
          onOpen={onOpen}
          onToggleMemory={() => {}}
          onToggleThinking={() => {}}
          onCancel={() => {}}
        />
      </ThemeContext.Provider>,
    );

    expect(view.lastFrame()).toContain('Subagent profiles');
    expect(view.lastFrame()).toContain('Compact model');
    view.stdin.write('a');
    expect(onOpen).toHaveBeenCalledWith('agents');
  });

  it('opens compact model settings from the keyboard shortcut', () => {
    const onOpen = vi.fn();
    const view = render(
      <ThemeContext.Provider value={DEFAULT_THEME}>
        <ConfigMenu
          model="gpt-5"
          themeName="dark"
          memoryAutoSave={false}
          showThinking
          agentCount={3}
          defaultPermissionMode="default"
          onOpen={onOpen}
          onToggleMemory={() => {}}
          onToggleThinking={() => {}}
          onCancel={() => {}}
        />
      </ThemeContext.Provider>,
    );

    view.stdin.write('c');
    expect(onOpen).toHaveBeenCalledWith('compact-model');
  });

  it('shows and opens the global default permission setting', () => {
    const onOpen = vi.fn();
    const view = render(
      <ThemeContext.Provider value={DEFAULT_THEME}>
        <ConfigMenu
          model="gpt-5"
          themeName="dark"
          memoryAutoSave={false}
          showThinking
          agentCount={3}
          defaultPermissionMode="accept-edits"
          onOpen={onOpen}
          onToggleMemory={() => {}}
          onToggleThinking={() => {}}
          onCancel={() => {}}
        />
      </ThemeContext.Provider>,
    );

    expect(view.lastFrame()).toContain('Default permissions');
    expect(view.lastFrame()).toContain('accept-edits');
    view.stdin.write('p');
    expect(onOpen).toHaveBeenCalledWith('permission-mode');
  });

  it('shows and toggles model thinking from the keyboard shortcut', () => {
    const onToggleThinking = vi.fn();
    const view = render(
      <ThemeContext.Provider value={DEFAULT_THEME}>
        <ConfigMenu
          model="gpt-5"
          themeName="dark"
          memoryAutoSave={false}
          showThinking={false}
          agentCount={3}
          defaultPermissionMode="default"
          onOpen={() => {}}
          onToggleMemory={() => {}}
          onToggleThinking={onToggleThinking}
          onCancel={() => {}}
        />
      </ThemeContext.Provider>,
    );

    expect(view.lastFrame()).toContain('Show thinking');
    expect(view.lastFrame()).toContain('off');
    view.stdin.write('i');
    expect(onToggleThinking).toHaveBeenCalledOnce();
  });

  it('fits narrow terminals', () => {
    const view = render(
      <ThemeContext.Provider value={DEFAULT_THEME}>
        <ConfigMenu
          model="9router/qc/qwen3.7-max"
          themeName="dark"
          memoryAutoSave={false}
          showThinking
          agentCount={3}
          defaultPermissionMode="default"
          terminalWidth={42}
          onOpen={() => {}}
          onToggleMemory={() => {}}
          onToggleThinking={() => {}}
          onCancel={() => {}}
        />
      </ThemeContext.Provider>,
    );

    const lines = stripAnsi(view.lastFrame()).split('\n');
    expect(Math.max(...lines.map((line) => line.length))).toBeLessThanOrEqual(42);
  });
});
