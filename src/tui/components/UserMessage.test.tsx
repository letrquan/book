import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from 'ink-testing-library';
import { ThemeContext, DEFAULT_THEME } from '../theme.js';
import { DensityContext } from '../density.js';
import { displayWidth } from './word-wrap.js';
import { UserMessage } from './UserMessage.js';

function stripAnsi(value: string | undefined): string {
  return (value ?? '').replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '');
}

function withTheme(children: React.ReactElement): React.ReactElement {
  return <ThemeContext.Provider value={DEFAULT_THEME}>{children}</ThemeContext.Provider>;
}

afterEach(() => cleanup());

describe('UserMessage', () => {
  it('adds a lead-in row around user messages in compact density', () => {
    const view = render(withTheme(<UserMessage content="compact request" terminalWidth={40} />));
    const lines = stripAnsi(view.lastFrame()).split('\n');

    expect(lines).toHaveLength(2);
    expect(lines[0].trim()).toBe('');
    expect(lines[1]).toContain('compact request');
    expect(displayWidth(lines[1])).toBeLessThanOrEqual(40);
  });

  it('keeps file mentions on the compact row', () => {
    const view = render(withTheme(<UserMessage content="check @src/app.ts" terminalWidth={40} />));
    const output = stripAnsi(view.lastFrame());

    expect(output.split('\n')).toHaveLength(2);
    expect(output).toContain('@src/app.ts');
  });

  it('keeps the user message single-row in tight density', () => {
    const view = render(
      withTheme(
        <DensityContext.Provider value="tight">
          <UserMessage content="tight request" terminalWidth={40} />
        </DensityContext.Provider>,
      ),
    );
    const lines = stripAnsi(view.lastFrame()).split('\n');

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('tight request');
  });
});
