import { describe, expect, it } from 'vitest';
import { parseEnvBoolean } from './env-boolean.js';

describe('parseEnvBoolean', () => {
  it('reads the spellings a shell script, a CI job and a human reach for', () => {
    for (const off of ['0', 'false', 'off', 'no']) {
      expect(parseEnvBoolean(off)).toBe(false);
    }
    for (const on of ['1', 'true', 'on', 'yes']) {
      expect(parseEnvBoolean(on)).toBe(true);
    }
  });

  it('ignores case and surrounding whitespace', () => {
    expect(parseEnvBoolean('  OFF ')).toBe(false);
    expect(parseEnvBoolean('On')).toBe(true);
    expect(parseEnvBoolean('\tYES\n')).toBe(true);
  });

  it('says nothing for an unset variable, an empty one, or a typo', () => {
    // Undefined rather than false: a caller that wants the "on" default cannot
    // tell an absent variable from one set to a word that means nothing, and
    // guessing either way is what makes an env override hard to reason about.
    expect(parseEnvBoolean(undefined)).toBeUndefined();
    expect(parseEnvBoolean('')).toBeUndefined();
    expect(parseEnvBoolean('   ')).toBeUndefined();
    expect(parseEnvBoolean('maybe')).toBeUndefined();
    expect(parseEnvBoolean('2')).toBeUndefined();
    expect(parseEnvBoolean('enabled')).toBeUndefined();
  });
});
