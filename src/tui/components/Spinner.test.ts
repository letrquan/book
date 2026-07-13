import { describe, expect, it } from 'vitest';
import { SPINNER_TIPS } from './Spinner.js';

describe('Spinner tips', () => {
  it('does not advertise unsupported application scrolling keys', () => {
    const tips = SPINNER_TIPS.join('\n');
    expect(tips).not.toMatch(/PgUp|PgDn|End to jump/);
    expect(tips).toContain('terminal scrollback');
  });
});
