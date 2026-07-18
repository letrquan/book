import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from 'ink-testing-library';
import { DEFAULT_THEME, ThemeContext } from '../theme.js';
import { CompactDiffCard } from './CompactDiffCard.js';

function stripAnsi(value: string | undefined): string {
  return (value ?? '').replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '');
}

afterEach(() => cleanup());

describe('CompactDiffCard', () => {
  it('renders degraded compaction as a successful warning with retrieval guidance', () => {
    const view = render(
      <ThemeContext.Provider value={DEFAULT_THEME}>
        <CompactDiffCard
          state={{
            phase: 'done',
            trigger: 'manual',
            preMessages: 20,
            message: 'Conversation compacted with reduced fidelity',
            degraded: true,
            warning: 'Compaction omitted older coverage. Exact history remains searchable.',
            strategy: 'multi-pass',
            modelCalls: 15,
          }}
          terminalWidth={80}
          reducedMotion
        />
      </ThemeContext.Provider>,
    );

    const output = stripAnsi(view.lastFrame());
    expect(output).toContain('Conversation compacted with reduced fidelity');
    expect(output).toContain('Exact history remains searchable');
    expect(output).not.toContain('error');
  });
});
