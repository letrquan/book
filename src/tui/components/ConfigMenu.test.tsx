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
          skillCount={4}
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
          skillCount={4}
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

  it('does not expose the experimental Zero-Mem strategy in normal settings', () => {
    const view = render(
      <ThemeContext.Provider value={DEFAULT_THEME}>
        <ConfigMenu
          model="gpt-5"
          themeName="dark"
          memoryAutoSave={false}
          showThinking
          agentCount={3}
          skillCount={4}
          defaultPermissionMode="default"
          onOpen={() => {}}
          onToggleMemory={() => {}}
          onToggleThinking={() => {}}
          onCancel={() => {}}
        />
      </ThemeContext.Provider>,
    );

    expect(view.lastFrame()).not.toContain('Compact strategy');
    expect(view.lastFrame()).not.toContain('Zero-Mem');
    expect(view.lastFrame()).not.toContain('R strategy');
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
          skillCount={4}
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

  it('opens skill management from settings', () => {
    const onOpen = vi.fn();
    const view = render(
      <ThemeContext.Provider value={DEFAULT_THEME}>
        <ConfigMenu
          model="gpt-5"
          themeName="dark"
          memoryAutoSave={false}
          showThinking
          agentCount={3}
          skillCount={4}
          defaultPermissionMode="default"
          onOpen={onOpen}
          onToggleMemory={() => {}}
          onToggleThinking={() => {}}
          onCancel={() => {}}
        />
      </ThemeContext.Provider>,
    );

    expect(view.lastFrame()).toContain('4 discovered');
    view.stdin.write('s');
    expect(onOpen).toHaveBeenCalledWith('skills');
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
          skillCount={4}
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

  it('shows and toggles startup fire from the keyboard shortcut', () => {
    const onToggleStartupAnimation = vi.fn();
    const view = render(
      <ThemeContext.Provider value={DEFAULT_THEME}>
        <ConfigMenu
          model="gpt-5"
          themeName="dark"
          memoryAutoSave={false}
          showThinking
          startupAnimation={false}
          agentCount={3}
          skillCount={4}
          defaultPermissionMode="default"
          onOpen={() => {}}
          onToggleMemory={() => {}}
          onToggleThinking={() => {}}
          onToggleStartupAnimation={onToggleStartupAnimation}
          onCancel={() => {}}
        />
      </ThemeContext.Provider>,
    );

    expect(view.lastFrame()).toContain('Startup fire');
    expect(view.lastFrame()).toContain('off');
    view.stdin.write('f');
    expect(onToggleStartupAnimation).toHaveBeenCalledOnce();
  });

  it('prints every accelerator beside the row it acts on', () => {
    const view = render(
      <ThemeContext.Provider value={DEFAULT_THEME}>
        <ConfigMenu
          model="gpt-5"
          themeName="dark"
          memoryAutoSave={false}
          showThinking
          agentCount={3}
          skillCount={4}
          defaultPermissionMode="default"
          onOpen={() => {}}
          onToggleMemory={() => {}}
          onToggleThinking={() => {}}
          onCancel={() => {}}
        />
      </ThemeContext.Provider>,
    );

    const frame = stripAnsi(view.lastFrame());
    for (const [letter, label] of [
      ['M', 'Model'],
      ['C', 'Compact model'],
      ['E', 'Effort'],
      ['I', 'Show thinking'],
      ['F', 'Startup fire'],
      ['T', 'Theme'],
      ['P', 'Default permissions'],
      ['A', 'Subagent profiles'],
      ['S', 'Skills'],
    ]) {
      expect(frame).toContain(`${letter}  ${label}`);
    }
    // The row with no accelerator advertises none rather than a contrived one.
    expect(frame).toContain('   Memory auto-capture');
    expect(frame).not.toMatch(/\S {2}Memory auto-capture/);
  });

  it('moves the cursor onto the row an accelerator acts on', () => {
    const onToggleStartupAnimation = vi.fn();
    const view = render(
      <ThemeContext.Provider value={DEFAULT_THEME}>
        <ConfigMenu
          model="gpt-5"
          themeName="dark"
          memoryAutoSave={false}
          showThinking
          startupAnimation={false}
          agentCount={3}
          skillCount={4}
          defaultPermissionMode="default"
          onOpen={() => {}}
          onToggleMemory={() => {}}
          onToggleThinking={() => {}}
          onToggleStartupAnimation={onToggleStartupAnimation}
          onCancel={() => {}}
        />
      </ThemeContext.Provider>,
    );

    // `f` acts on "Startup fire", five rows below the cursor's start. Enter must
    // then repeat that row rather than opening the model picker the cursor
    // began on — otherwise the change happened somewhere the user was not
    // looking.
    view.stdin.write('f');
    view.stdin.write('\r');
    expect(onToggleStartupAnimation).toHaveBeenCalledTimes(2);
  });

  it('reaches the unlettered row with the arrows and ignores unbound letters', () => {
    const onOpen = vi.fn();
    const onToggleMemory = vi.fn();
    const view = render(
      <ThemeContext.Provider value={DEFAULT_THEME}>
        <ConfigMenu
          model="gpt-5"
          themeName="dark"
          memoryAutoSave={false}
          showThinking
          agentCount={3}
          skillCount={4}
          defaultPermissionMode="default"
          onOpen={onOpen}
          onToggleMemory={onToggleMemory}
          onToggleThinking={() => {}}
          onCancel={() => {}}
        />
      </ThemeContext.Provider>,
    );

    view.stdin.write('z');
    expect(onOpen).not.toHaveBeenCalled();
    expect(onToggleMemory).not.toHaveBeenCalled();

    // Memory is the last row, so one step up from the top wraps onto it.
    view.stdin.write('\u001b[A');
    view.stdin.write('\r');
    expect(onToggleMemory).toHaveBeenCalledOnce();
    expect(onOpen).not.toHaveBeenCalled();
  });

  it('walks back up the list on Shift+Tab', () => {
    const onOpen = vi.fn();
    const view = render(
      <ThemeContext.Provider value={DEFAULT_THEME}>
        <ConfigMenu
          model="gpt-5"
          themeName="dark"
          memoryAutoSave={false}
          showThinking
          agentCount={3}
          skillCount={4}
          defaultPermissionMode="default"
          onOpen={onOpen}
          onToggleMemory={() => {}}
          onToggleThinking={() => {}}
          onCancel={() => {}}
        />
      </ThemeContext.Provider>,
    );

    // Tab down twice to Effort, then back-tab once. Reading `key.tab` without
    // `key.shift` sent Shift+Tab forward instead, one row past the target.
    view.stdin.write('\t');
    view.stdin.write('\t');
    view.stdin.write('\u001b[Z');
    view.stdin.write('\r');
    expect(onOpen).toHaveBeenCalledWith('compact-model');
  });

  it('stops the footer from advertising a subset of the shortcuts', () => {
    const view = render(
      <ThemeContext.Provider value={DEFAULT_THEME}>
        <ConfigMenu
          model="gpt-5"
          themeName="dark"
          memoryAutoSave={false}
          showThinking
          agentCount={3}
          skillCount={4}
          defaultPermissionMode="default"
          onOpen={() => {}}
          onToggleMemory={() => {}}
          onToggleThinking={() => {}}
          onCancel={() => {}}
        />
      </ThemeContext.Provider>,
    );

    // The old footer named four of the nine letters, so the other five were
    // reachable but undocumented. The rows carry them now.
    const footer = stripAnsi(view.lastFrame())
      .split('\n')
      .find((line) => line.includes('↑↓ select'));
    expect(footer).toContain('press the letter');
    expect(footer).not.toContain('M model');
    expect(footer).not.toContain('C compact');
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
          skillCount={4}
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
