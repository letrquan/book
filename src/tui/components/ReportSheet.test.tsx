import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from 'ink-testing-library';
import type { ContextCommandDisplay } from '../../types/messages.js';
import { DEFAULT_THEME, ThemeContext } from '../theme.js';
import { diffSummary, ReportBody, type ReportSheetContent } from './ReportSheet.js';

function stripAnsi(value: string | undefined): string {
  return (value ?? '').replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '');
}

function frame(sheet: ReportSheetContent, screenReader: boolean): string {
  const view = render(
    <ThemeContext.Provider value={DEFAULT_THEME}>
      <ReportBody sheet={sheet} terminalWidth={100} screenReader={screenReader} />
    </ThemeContext.Provider>,
  );
  return stripAnsi(view.lastFrame());
}

const contextDisplay: ContextCommandDisplay = {
  kind: 'context',
  model: 'claude-sonnet-5',
  maxTokens: 128_000,
  estimatedTokens: 32_000,
  totalMessages: 12,
  userMessages: 6,
  assistantMessages: 6,
  toolCalls: 8,
  toolResults: 7,
  userTokens: 8_000,
  assistantTokens: 24_000,
  ambient: {
    commandCount: 24,
    skillCount: 3,
    subagentCount: 1,
    hasMemoryIndex: true,
    hasClaudeMdLoader: false,
  },
};

const DIFF = [
  'diff --git a/a.txt b/a.txt',
  '--- a/a.txt',
  '+++ b/a.txt',
  '@@ -1,2 +1,2 @@',
  '-old',
  '+new',
  ' same',
  'diff --git a/b.txt b/b.txt',
  '--- a/b.txt',
  '+++ b/b.txt',
  '@@ -1 +1,2 @@',
  ' keep',
  '+added',
].join('\n');

afterEach(() => {
  cleanup();
});

// The dialog carries the title and the keys (`Dialog.test.tsx`); these are the bodies under them.
describe('ReportBody', () => {
  it("lays out a figure report under its subtitle, with no rule of the panel's own", () => {
    const shown = frame(
      { title: 'Context', content: 'Context report', display: contextDisplay },
      false,
    );
    expect(shown.split('\n')[0]).toContain('claude-sonnet-5');
    expect(shown).not.toContain('§');
    expect(shown).not.toContain('Esc');
  });

  it('gives a screen reader the text report', () => {
    const shown = frame(
      { title: 'Context', content: 'Context report text', display: contextDisplay },
      true,
    );
    expect(shown).toContain('Context report text');
  });

  it('shows a text report as written', () => {
    const shown = frame({ title: 'Cost', content: '120 tokens (100 in, 20 out)' }, false);
    expect(shown).toContain('120 tokens (100 in, 20 out)');
    expect(shown).not.toContain('Esc');
  });

  it('heads a diff with its summary, as Claude Code heads its diff dialog', () => {
    const lines = frame({ title: 'Diff', content: DIFF }, false).split('\n');
    expect(lines[0]?.trim()).toBe('2 files · +2 −1');
    expect(lines.join('\n')).toContain('added');
  });
});

describe('diffSummary', () => {
  it('counts files and changed lines, not the file headers', () => {
    expect(diffSummary(DIFF)).toBe('2 files · +2 −1');
  });

  it('leaves out the file count when the diff names no file', () => {
    expect(diffSummary('@@ -1 +1 @@\n-a\n+b')).toBe('+1 −1');
  });
});
