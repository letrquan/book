import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from 'ink-testing-library';
import { DEFAULT_THEME, ThemeContext } from '../theme.js';
import { CommandMenu, getCommandMenuWindow } from './CommandMenu.js';
import { displayWidth } from './word-wrap.js';
import type { CommandItem } from '../../commands/filter.js';

function stripAnsi(value: string | undefined): string {
  return (value ?? '').replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '');
}

function withTheme(children: React.ReactElement): React.ReactElement {
  return <ThemeContext.Provider value={DEFAULT_THEME}>{children}</ThemeContext.Provider>;
}

const items: CommandItem[] = [
  { name: 'clear', hint: '', desc: 'Clear conversation', category: 'builtin' },
  { name: 'compact', hint: '', desc: 'Summarize older turns', category: 'builtin' },
  { name: 'config', hint: '<key=value>', desc: 'Change configuration', category: 'builtin' },
  { name: 'context', hint: '', desc: 'Show context usage', category: 'builtin' },
  { name: 'cost', hint: '', desc: 'Show cost', category: 'builtin' },
  { name: 'review', hint: '[scope]', desc: 'Review current git diff', category: 'builtin' },
];

afterEach(() => cleanup());

describe('getCommandMenuWindow', () => {
  it('keeps the selected command inside the visible window', () => {
    expect(getCommandMenuWindow(10, 0, 4)).toEqual({ start: 0, end: 4 });
    expect(getCommandMenuWindow(10, 5, 4)).toEqual({ start: 3, end: 7 });
    expect(getCommandMenuWindow(10, 9, 4)).toEqual({ start: 6, end: 10 });
  });
});

describe('CommandMenu', () => {
  it('caps visible rows and shows a hidden-count footer', () => {
    const view = render(
      withTheme(
        <CommandMenu items={items} filterText="" selectedIndex={4} visible terminalWidth={48} maxRows={3} reducedMotion />,
      ),
    );

    const output = stripAnsi(view.lastFrame());
    expect(output).toContain('Commands');
    expect(output).toContain('cost');
    expect(output).toContain('… 3 more, type to filter');
  });

  it('keeps rendered lines within the requested width', () => {
    const width = 34;
    const view = render(
      withTheme(
        <CommandMenu items={items} filterText="co" selectedIndex={2} visible terminalWidth={width} maxRows={4} compact reducedMotion />,
      ),
    );

    for (const line of stripAnsi(view.lastFrame()).split('\n').filter(Boolean)) {
      expect(displayWidth(line)).toBeLessThanOrEqual(width);
    }
  });
});
