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
          effort="high"
          themeName="dark"
          memoryAutoSave={false}
          agentCount={3}
          onOpen={onOpen}
          onToggleMemory={() => {}}
          onCancel={() => {}}
        />
      </ThemeContext.Provider>,
    );

    expect(view.lastFrame()).toContain('Subagent profiles');
    view.stdin.write('a');
    expect(onOpen).toHaveBeenCalledWith('agents');
  });

  it('fits narrow terminals', () => {
    const view = render(
      <ThemeContext.Provider value={DEFAULT_THEME}>
        <ConfigMenu
          model="9router/qc/qwen3.7-max"
          themeName="dark"
          memoryAutoSave={false}
          agentCount={3}
          terminalWidth={42}
          onOpen={() => {}}
          onToggleMemory={() => {}}
          onCancel={() => {}}
        />
      </ThemeContext.Provider>,
    );

    const lines = stripAnsi(view.lastFrame()).split('\n');
    expect(Math.max(...lines.map((line) => line.length))).toBeLessThanOrEqual(42);
  });
});
