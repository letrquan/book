import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from 'ink-testing-library';
import { DEFAULT_THEME, ThemeContext } from '../theme.js';
import { StatusLine } from './StatusLine.js';
import { displayWidth } from './word-wrap.js';

function stripAnsi(value: string | undefined): string {
  return (value ?? '').replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '');
}

function withTheme(children: React.ReactElement): React.ReactElement {
  return <ThemeContext.Provider value={DEFAULT_THEME}>{children}</ThemeContext.Provider>;
}

afterEach(() => cleanup());

describe('StatusLine', () => {
  it('renders full status on wide terminals', () => {
    const view = render(
      withTheme(
        <StatusLine
          model="claude-sonnet-5"
          tokenCount={12_000}
          maxTokens={128_000}
          mode="default"
          taskCount={3}
          activeTaskCount={1}
          terminalWidth={100}
          reducedMotion
        />,
      ),
    );

    const output = stripAnsi(view.lastFrame());
    expect(output).toContain('claude-sonnet-5');
    expect(output).toContain('tokens 12.0k/128k');
    expect(output).toContain('default');
    expect(output).toContain('tasks 1/3');
  });

  it('keeps narrow output within terminal width', () => {
    const width = 36;
    const view = render(
      withTheme(
        <StatusLine
          model="very-long-model-name-that-needs-truncation"
          tokenCount={64_000}
          maxTokens={128_000}
          mode="accept-edits"
          taskCount={0}
          activeTaskCount={0}
          terminalWidth={width}
          compact
          reducedMotion
        />,
      ),
    );

    for (const line of stripAnsi(view.lastFrame()).split('\n').filter(Boolean)) {
      expect(displayWidth(line)).toBeLessThanOrEqual(width);
    }
  });

  it('folds context warning into compact status', () => {
    const view = render(
      withTheme(
        <StatusLine
          model="model"
          tokenCount={124_000}
          maxTokens={128_000}
          mode="plan"
          taskCount={0}
          activeTaskCount={0}
          terminalWidth={44}
          compact
          reducedMotion
        />,
      ),
    );

    const output = stripAnsi(view.lastFrame());
    expect(output).toContain('ctx 97%');
    expect(output).not.toContain('Context nearly full');
  });
});
