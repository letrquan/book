import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from 'ink-testing-library';
import { Text } from 'ink';
import { DEFAULT_THEME, ThemeContext } from '../theme.js';
import { ChoiceList, DecisionRule, DecisionSheet } from './chrome.js';
import { displayWidth } from './word-wrap.js';

function stripAnsi(value: string | undefined): string {
  return (value ?? '').replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '');
}

function frame(element: React.ReactElement): string[] {
  const view = render(
    <ThemeContext.Provider value={DEFAULT_THEME}>{element}</ThemeContext.Provider>,
  );
  return stripAnsi(view.lastFrame()).split('\n');
}

afterEach(() => cleanup());

describe('DecisionRule', () => {
  it('spans exactly its width, with or without a note', () => {
    for (const width of [56, 79, 96]) {
      const [plain] = frame(<DecisionRule label="Permission required" tone="red" width={width} />);
      expect(displayWidth(plain!)).toBe(width);
      const [noted] = frame(
        <DecisionRule label="Permission required" tone="red" meta="shell command" width={width} />,
      );
      expect(displayWidth(noted!)).toBe(width);
      expect(noted).toMatch(/^─ ¶ Permission required ─+ shell command ─$/);
    }
  });

  it('gives up the note before the label on a tight row', () => {
    const [row] = frame(
      <DecisionRule label="Permission required" tone="red" meta="a rather long note" width={34} />,
    );
    expect(row).toContain('Permission required');
    expect(row).not.toContain('long note');
    expect(displayWidth(row!)).toBe(34);
  });
});

describe('DecisionSheet', () => {
  it('opens with a row of air and the rule, and sets the body on the content column', () => {
    const lines = frame(
      <DecisionSheet label="Question" tone="white" meta="Scope · 1 of 2" width={60}>
        <Text>Which settings?</Text>
      </DecisionSheet>,
    );
    expect(lines[0]).toBe('');
    expect(lines[1]).toMatch(/^─ ¶ Question ─+ Scope · 1 of 2 ─$/);
    expect(lines[2]).toBe('  Which settings?');
    expect(lines.join('\n')).not.toMatch(/[╭╮╰╯│]/);
  });
});

describe('ChoiceList', () => {
  const choices = [
    { label: 'The default (1000)', detail: 'Treat an empty value like a missing one.' },
    { label: 'Disable', detail: 'Keep today.' },
    { label: 'Other…', numeral: '+' },
  ];

  it('marks the chosen row with one cursor and lines the details up', () => {
    const lines = frame(<ChoiceList choices={choices} selected={1} width={76} />);
    expect(lines.filter((line) => line.startsWith('› '))).toEqual([lines[1]]);
    expect(lines[0]!.indexOf('Treat')).toBe(lines[1]!.indexOf('Keep'));
    expect(lines[2]).toMatch(/^ {2}\+ {2}Other…$/);
  });

  it('numbers rows only when asked, and draws no cursor while inactive', () => {
    const unnumbered = frame(
      <ChoiceList choices={choices} selected={0} width={76} numbered={false} />,
    );
    expect(unnumbered[0]).toMatch(/^› The default/);
    const inactive = frame(<ChoiceList choices={choices} selected={0} width={76} active={false} />);
    expect(inactive.some((line) => line.startsWith('›'))).toBe(false);
  });

  it('keeps a column for a tick when marks are on', () => {
    const lines = frame(
      <ChoiceList
        choices={[{ label: 'RETRIES', checked: true }, { label: 'PORT' }]}
        selected={1}
        width={76}
        marks
      />,
    );
    expect(lines[0]).toMatch(/^ {2}✓ 1 {2}RETRIES/);
    expect(lines[1]).toMatch(/^› {3}2 {2}PORT/);
  });
});
