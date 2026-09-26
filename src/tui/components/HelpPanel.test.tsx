import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from 'ink-testing-library';
import { DEFAULT_THEME, ThemeContext } from '../theme.js';
import { builtinHelpGroups } from '../help-catalog.js';
import { HelpPanel } from './HelpPanel.js';
import { KeyValueList } from './chrome.js';
import { displayWidth } from './word-wrap.js';

function stripAnsi(value: string | undefined): string {
  return (value ?? '').replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '');
}

function lines(element: React.ReactElement): string[] {
  const view = render(
    <ThemeContext.Provider value={DEFAULT_THEME}>{element}</ThemeContext.Provider>,
  );
  return stripAnsi(view.lastFrame()).split('\n');
}

afterEach(() => cleanup());

describe('HelpPanel', () => {
  it('heads the list with a ruled title that counts the commands', () => {
    const count = builtinHelpGroups().reduce((sum, group) => sum + group.entries.length, 0);
    const head = lines(<HelpPanel width={96} />).find((line) => line.startsWith('─'));
    expect(head).toMatch(new RegExp(`^─ § Commands ─+ ${count} · Esc to close ─$`));
    expect(displayWidth(head!)).toBe(96);
  });

  it('sets the groups as headings and stays inside its width', () => {
    for (const width of [60, 79, 96]) {
      const frame = lines(<HelpPanel width={width} />);
      for (const line of frame) expect(displayWidth(line)).toBeLessThanOrEqual(width);
      expect(frame.some((line) => /^ {2}Conversation\b/.test(line))).toBe(true);
      expect(frame.some((line) => line.includes('/clear, /new'))).toBe(true);
    }
  });

  it('flows into two columns on a wide sheet, so the list fits on one screen', () => {
    const narrow = lines(<HelpPanel width={79} />).filter(Boolean);
    const wide = lines(<HelpPanel width={96} />).filter(Boolean);
    expect(wide.length).toBeLessThan(narrow.length * 0.7);
    expect(wide.length).toBeLessThanOrEqual(40);
    // Two columns drop the syntax; one column keeps it.
    expect(narrow.join(' ')).toContain('[previous-name]');
    expect(wide.join(' ')).not.toContain('[previous-name]');
  });

  it('lines every description in a column up at one place', () => {
    const frame = lines(<HelpPanel width={79} />);
    const rows = frame.filter((line) => line.startsWith('  /'));
    // Names hold single spaces only, so the first run of two or more spaces is
    // the gutter before the description.
    const column = (line: string) => {
      const gutter = /\s{2,}(?=\S)/.exec(line.slice(2));
      return gutter ? gutter.index + gutter[0].length : -1;
    };
    expect(rows.length).toBeGreaterThan(20);
    expect(new Set(rows.map(column)).size).toBe(1);
  });

  it('adds custom commands in their own group', () => {
    const frame = lines(
      <HelpPanel
        width={79}
        customCommands={[{ name: 'ship', description: 'Tag and push a release' }]}
      />,
    ).join('\n');
    expect(frame).toMatch(/^ {2}Custom$/m);
    expect(frame).toContain('/ship');
    expect(frame).toContain('Tag and push a release');
  });
});

describe('KeyValueList', () => {
  it('starts every value at the same column', () => {
    const frame = lines(
      <KeyValueList
        width={60}
        rows={[
          { key: 'model', value: 'claude-opus-5-5' },
          { key: 'workspace', value: 'D:/MyPoorSoul/book' },
          { key: 'mode', value: 'plan' },
        ]}
      />,
    );
    const starts = frame.filter(Boolean).map((line) => line.search(/\S+$/));
    expect(new Set(starts).size).toBe(1);
    // The key column fits the longest key whole: nothing reads "Workspac".
    expect(frame.join('\n')).toContain('workspace');
  });

  it('wraps a long value inside the width instead of running past it', () => {
    const frame = lines(
      <KeyValueList width={40} rows={[{ key: 'tasks', value: 'one two three '.repeat(8) }]} />,
    );
    expect(frame.filter(Boolean).length).toBeGreaterThan(1);
    for (const line of frame) expect(displayWidth(line)).toBeLessThanOrEqual(40);
  });
});
