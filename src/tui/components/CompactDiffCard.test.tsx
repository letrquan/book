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
      <CompactDiffCard state={state} terminalWidth={80} />
    </ThemeContext.Provider>,
  );
}

describe('CompactDiffCard', () => {
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

  it('renders a skip with its reason', () => {
    const output = stripAnsi(
      renderCard({
        phase: 'skipped',
        trigger: 'manual',
        message: 'Not enough messages to compact.',
      }).lastFrame(),
    );

    expect(output).toContain('– Not enough messages to compact.');
  });

  it('renders nothing while a compaction is running', () => {
    expect(stripAnsi(renderCard({ phase: 'working', trigger: 'manual' }).lastFrame()).trim()).toBe(
      '',
    );
  });
});
