import { describe, expect, it } from 'vitest';
import { EFFORT_LEVELS, isEffortLevel, parseEffortLevel } from './effort.js';
import { effortLevelSchema } from '../settings.js';

describe('EFFORT_LEVELS', () => {
  it('is the settings schema, not a second copy of it', () => {
    // The levels were written down three times — here, as a Set in config.ts, and
    // as the zod enum. Deriving from the schema is what keeps the CLI flag, the
    // env var, settings.effort, and /effort from disagreeing.
    expect([...EFFORT_LEVELS]).toEqual(effortLevelSchema.options);
  });
});

describe('parseEffortLevel', () => {
  it('rejects a typo instead of forwarding it to the provider', () => {
    // The failure this exists for: `--effort bogus` was a bare cast, so the value
    // reached the provider as reasoning_effort/output_config.effort and came back
    // as an opaque HTTP 400 for a mistake the CLI could have named exactly.
    expect(() => parseEffortLevel('bogus', '--effort')).toThrow(
      /--effort must be one of: low, medium, high, xhigh, max \(got "bogus"\)/,
    );
  });

  it('names the option it was given, so the message points at the right input', () => {
    expect(() => parseEffortLevel('xxl', 'BOOK_EFFORT')).toThrow(/^BOOK_EFFORT must be one of/);
  });

  it('normalizes case and surrounding space the way the env var already did', () => {
    expect(parseEffortLevel(' HIGH ', '--effort')).toBe('high');
    expect(parseEffortLevel('XHigh', '--effort')).toBe('xhigh');
  });

  it('accepts every level the schema allows', () => {
    for (const level of EFFORT_LEVELS) {
      expect(parseEffortLevel(level, '--effort')).toBe(level);
    }
  });

  it('rejects an empty value rather than treating it as unset', () => {
    // An unset flag never reaches here; an empty one is a mistake worth naming.
    expect(() => parseEffortLevel('', '--effort')).toThrow(/must be one of/);
  });
});

describe('isEffortLevel', () => {
  it('accepts the schema levels and nothing else', () => {
    for (const level of EFFORT_LEVELS) expect(isEffortLevel(level)).toBe(true);
    expect(isEffortLevel('bogus')).toBe(false);
    expect(isEffortLevel('HIGH')).toBe(false);
  });
});
