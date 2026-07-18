import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from 'ink-testing-library';
import { ThemeContext, DEFAULT_THEME } from '../theme.js';
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
  it('restores the original vertical and horizontal padding', () => {
    const view = render(withTheme(<UserMessage content="compact request" terminalWidth={40} />));
    const lines = stripAnsi(view.lastFrame()).split('\n');

    expect(lines).toHaveLength(3);
    expect(lines[0].trim()).toBe('');
    expect(lines[1]).toContain('  compact request');
    expect(displayWidth(lines[1])).toBeLessThanOrEqual(40);
    expect(lines[2].trim()).toBe('');
  });

  it('keeps file mentions on the compact row', () => {
    const view = render(withTheme(<UserMessage content="check @src/app.ts" terminalWidth={40} />));
    const output = stripAnsi(view.lastFrame());

    expect(output.split('\n')).toHaveLength(3);
    expect(output).toContain('@src/app.ts');
  });
});
