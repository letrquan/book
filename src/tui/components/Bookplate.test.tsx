import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from 'ink-testing-library';
import { DEFAULT_THEME, ThemeContext } from '../theme.js';
import { Bookplate } from './Bookplate.js';

function stripAnsi(value: string | undefined): string {
  return (value ?? '').replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '');
}

afterEach(() => cleanup());

describe('Bookplate', () => {
  it('renders a compact two-line identity mark', () => {
    const view = render(
      <ThemeContext.Provider value={DEFAULT_THEME}>
        <Bookplate tagline="Your coding workspace, indexed." width={60} />
      </ThemeContext.Provider>,
    );
    const lines = stripAnsi(view.lastFrame()).split('\n');

    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('╭ BOOK');
    expect(lines[1]).toContain('╰ Your coding workspace, indexed.');
  });
});
