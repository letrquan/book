import { describe, expect, it } from 'vitest';
import { SPINNER_TIPS } from './Spinner.js';

describe('Spinner tips', () => {
  it('advertises supported transcript scrolling keys', () => {
    const tips = SPINNER_TIPS.join('\n');
    expect(tips).toContain('PageUp/PageDown');
    expect(tips).not.toContain('terminal scrollback');
  });
});
