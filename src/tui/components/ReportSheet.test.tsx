import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from 'ink-testing-library';
import type { ContextCommandDisplay } from '../../types/messages.js';
import { DEFAULT_THEME, ThemeContext } from '../theme.js';
import { diffSummary, ReportSheet, type ReportSheetContent } from './ReportSheet.js';

function stripAnsi(value: string | undefined): string {
  return (value ?? '').replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '');
}

function frame(sheet: ReportSheetContent, screenReader: boolean): string {
  const view = render(
    <ThemeContext.Provider value={DEFAULT_THEME}>
      <ReportSheet sheet={sheet} terminalWidth={100} reducedMotion screenReader={screenReader} />
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

describe('ReportSheet', () => {
  it('heads a figure sheet with its title and close hint', () => {
    const shown = frame(
      { title: 'Context', content: 'Context report', display: contextDisplay },
      false,
    );
    expect(shown).toContain('§ Context');
    expect(shown).toContain('Esc to close');
    expect(shown).not.toContain('/context');
  });

  it('keeps the title and close hint for a screen reader, with the text report as the body', () => {
    const shown = frame(
      { title: 'Context', content: 'Context report text', display: contextDisplay },
      true,
    );
    expect(shown).toContain('Context');
    expect(shown).toContain('Esc to close');
    expect(shown).toContain('Context report text');
  });

  it('shows a text report under its title', () => {
    const shown = frame({ title: 'Cost', content: '120 tokens (100 in, 20 out)' }, false);
    expect(shown).toContain('§ Cost');
    expect(shown).toContain('Esc to close');
    expect(shown).toContain('120 tokens (100 in, 20 out)');
  });

  it('ends a diff with its summary, the part of a long diff the view shows', () => {
    const lines = frame({ title: 'Diff', content: DIFF }, false).trimEnd().split('\n');
    expect(lines.at(-1)?.trim()).toBe('2 files · +2 −1 · Esc to close');
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
