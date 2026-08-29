import { describe, expect, it } from 'vitest';
import { parseNumericFlag } from './utils.js';

describe('parseNumericFlag', () => {
  it('rejects a typo instead of turning it into NaN', () => {
    // The failure this exists for: `parseInt('none', 10)` is NaN and `'none'` is
    // truthy, so the old truthiness guard passed it straight through. NaN then
    // loses every comparison it takes part in — `--max-turns none` ran zero turns
    // and reported `completed`, and `--max-budget-usd none` read as *configured*
    // while permitting unbounded spend.
    expect(() => parseNumericFlag('none', '--max-turns', { integer: true })).toThrow(
      /--max-turns expects a number/,
    );
    expect(() => parseNumericFlag('none', '--max-budget-usd')).toThrow(/expects a number/);
  });

  it('rejects a number with trailing junk rather than silently truncating it', () => {
    // Number.parseInt stops at the first bad character, so '12abc' would become 12.
    expect(() => parseNumericFlag('12abc', '--max-turns', { integer: true })).toThrow(
      /expects a number/,
    );
  });

  it('rejects a negative limit', () => {
    expect(() => parseNumericFlag('-5', '--max-budget-usd')).toThrow(/must be at least 0/);
  });

  it('rejects a fractional turn count', () => {
    expect(() => parseNumericFlag('2.5', '--max-turns', { integer: true })).toThrow(/whole number/);
  });

  it('distinguishes an explicit zero from an absent flag', () => {
    // `0` is falsy, so the old guard read an explicit zero cap as "no flag given"
    // and the run went unbudgeted.
    expect(parseNumericFlag('0', '--max-budget-usd')).toBe(0);
    expect(parseNumericFlag(undefined, '--max-budget-usd')).toBeUndefined();
    expect(parseNumericFlag('', '--max-budget-usd')).toBeUndefined();
  });

  it('accepts ordinary values', () => {
    expect(parseNumericFlag('25', '--max-turns', { integer: true })).toBe(25);
    expect(parseNumericFlag(' 12.50 ', '--max-budget-usd')).toBe(12.5);
    expect(parseNumericFlag('.5', '--max-budget-usd')).toBe(0.5);
  });
});
