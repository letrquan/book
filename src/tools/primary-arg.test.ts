import { describe, expect, it } from 'vitest';
import { getPrimaryArg } from './primary-arg.js';

describe('getPrimaryArg', () => {
  it('prefers the search pattern over the optional path scope', () => {
    expect(getPrimaryArg({ pattern: 'API_KEY', path: 'src' })).toBe('API_KEY');
  });

  it('still returns path for path-only calls', () => {
    expect(getPrimaryArg({ path: 'notes.md' })).toBe('notes.md');
  });

  it('extracts the first patched file from a patch envelope', () => {
    expect(
      getPrimaryArg({ patch: '*** Begin Patch\n*** Update File: src/a.ts\n*** End Patch' }),
    ).toBe('src/a.ts');
  });
});
