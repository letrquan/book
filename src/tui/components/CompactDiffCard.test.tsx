import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from 'ink-testing-library';
import { DEFAULT_THEME, ThemeContext } from '../theme.js';
import { CompactDiffCard } from './CompactDiffCard.js';

function stripAnsi(value: string | undefined): string {
  return (value ?? '').replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '');
}

afterEach(() => cleanup());

function renderCard(state: React.ComponentProps<typeof CompactDiffCard>['state']) {
  return render(
    <ThemeContext.Provider value={DEFAULT_THEME}>
      <CompactDiffCard state={state} terminalWidth={80} reducedMotion />
    </ThemeContext.Provider>,
  );
}

describe('CompactDiffCard', () => {
  it('renders successful compaction as a concise tool-style result row', () => {
    const output = stripAnsi(
      renderCard({
        phase: 'done',
        trigger: 'manual',
        preMessages: 20,
        preContextTokens: 12_340,
      }).lastFrame(),
    );

    expect(output).toContain('✓ Compact conversation');
    expect(output).toContain('20 messages');
    expect(output).toContain('~12.3k context');
    expect(output).not.toContain('older conversation turns');
    expect(output).not.toContain('Structured summary');
  });

  it('keeps reduced-fidelity retrieval guidance visible', () => {
    const output = stripAnsi(
      renderCard({
        phase: 'done',
        trigger: 'manual',
        preMessages: 20,
        degraded: true,
        warning: 'Exact history remains searchable.',
      }).lastFrame(),
    );

    expect(output).toContain('Compact conversation · reduced fidelity');
    expect(output).toContain('Exact history remains searchable.');
  });

  it('renders failures without a popup card', () => {
    const output = stripAnsi(
      renderCard({
        phase: 'error',
        trigger: 'manual',
        message: 'Provider unavailable.',
      }).lastFrame(),
    );

    expect(output).toContain('× Provider unavailable.');
    expect(output).not.toContain('╭');
  });
});
