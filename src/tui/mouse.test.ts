import { describe, expect, it } from 'vitest';
import { stripSgrMouseSequences } from './mouse.js';

describe('stripSgrMouseSequences', () => {
  it('removes mouse reports before and after Ink consumes the escape byte', () => {
    expect(stripSgrMouseSequences('\x1b[<64;13;20M')).toBe('');
    expect(stripSgrMouseSequences('[<0;13;20m')).toBe('');
    expect(stripSgrMouseSequences('before\x1b[<32;4;7Mafter')).toBe('beforeafter');
  });

  it('removes every report in a burst', () => {
    expect(stripSgrMouseSequences('\x1b[<0;4;2M\x1b[<32;5;2M\x1b[<0;5;2m')).toBe('');
  });

  it('leaves ordinary typed text alone', () => {
    expect(stripSgrMouseSequences('https://api.example.com/v1')).toBe('https://api.example.com/v1');
    expect(stripSgrMouseSequences('sk-[<abc>]')).toBe('sk-[<abc>]');
  });
});
