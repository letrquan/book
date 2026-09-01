import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from 'ink-testing-library';
import { DEFAULT_THEME, ThemeContext } from '../theme.js';
import { CommandMenu, composeCommandRow, getCommandMenuWindow } from './CommandMenu.js';
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
        <CommandMenu
          items={items}
          filterText=""
          selectedIndex={4}
          visible
          terminalWidth={48}
          maxRows={3}
          reducedMotion
        />,
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
        <CommandMenu
          items={items}
          filterText="co"
          selectedIndex={2}
          visible
          terminalWidth={width}
          maxRows={4}
          compact
          reducedMotion
        />,
      ),
    );

    for (const line of stripAnsi(view.lastFrame()).split('\n').filter(Boolean)) {
      expect(displayWidth(line)).toBeLessThanOrEqual(width);
    }
  });
});

describe('composeCommandRow', () => {
  const item = {
    name: 'agent',
    hint: '<id>|send <id> <message>|stop <id>',
    desc: 'Inspect or steer a managed agent',
    category: 'builtin' as const,
  };
  const base = {
    selected: false,
    width: 76,
    compact: false,
    shimmer: false,
    screenReader: false,
    showBadge: false,
  };

  it('puts what the command does ahead of how it is spelled', () => {
    // The syntax used to sit between the name and the description, so an
    // 80-column row showed the grammar and then truncated the meaning away.
    const row = composeCommandRow(item, base);
    expect(row.name).toBe('/agent');
    expect(row.hint).toBe('');
    expect(row.desc).toBe(' — Inspect or steer a managed agent');
  });

  it('shows the syntax only on the row the user has landed on', () => {
    const row = composeCommandRow(item, { ...base, selected: true, width: 120 });
    expect(row.hint).toBe(' <id>|send <id> <message>|stop <id>');
  });

  it('drops the syntax rather than starving the description', () => {
    const row = composeCommandRow(item, { ...base, selected: true, width: 46 });
    expect(row.hint).toBe('');
    expect(row.desc.length).toBeGreaterThan(0);
  });

  it('omits the badge unless the visible rows actually differ', () => {
    expect(composeCommandRow(item, base).badge).toBe('');
    expect(composeCommandRow(item, { ...base, showBadge: true }).badge).toBe(' [Built-in]');
  });

  it('keeps the whole row inside its width', () => {
    for (const width of [24, 32, 48, 64, 80, 120]) {
      for (const selected of [false, true]) {
        const row = composeCommandRow(item, { ...base, selected, width });
        const rendered = `${row.marker}${row.name}${row.hint}${row.badge}${row.desc}`;
        expect(displayWidth(rendered)).toBeLessThanOrEqual(width);
      }
    }
  });

  it('marks the selected row and indents the rest to the same column', () => {
    expect(composeCommandRow(item, { ...base, selected: true }).marker).toBe('› ');
    expect(composeCommandRow(item, { ...base, selected: true, shimmer: true }).marker).toBe('▸ ');
    expect(composeCommandRow(item, base).marker).toBe('  ');
  });
});
