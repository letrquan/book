import { homedir } from 'os';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { parseSecretReference, resolveSecretFilePath } from './secret-reference.js';

describe('parseSecretReference', () => {
  it('classifies env, file and literal keys', () => {
    expect(parseSecretReference('{env:KEY}')).toEqual({ kind: 'env', name: 'KEY' });
    expect(parseSecretReference('{file:~/k}')).toEqual({ kind: 'file', path: '~/k' });
    expect(parseSecretReference('sk-literal')).toEqual({ kind: 'literal' });
    // Text around a reference makes it a literal, as the resolver has always read it.
    expect(parseSecretReference('x{env:KEY}')).toEqual({ kind: 'literal' });
    expect(parseSecretReference('{env:}')).toEqual({ kind: 'literal' });
  });
});

describe('resolveSecretFilePath', () => {
  it('expands ~/ and resolves .. segments', () => {
    expect(resolveSecretFilePath('~/a/../b', '/ws')).toEqual({
      path: join(homedir(), 'b'),
      readable: true,
    });
  });

  it('normalises an absolute path', () => {
    expect(resolveSecretFilePath('/a/b/../c', '/ws')).toEqual({ path: '/a/c', readable: true });
  });

  it('roots a relative path at the workspace, and marks one that leaves it unreadable', () => {
    expect(resolveSecretFilePath('k/key', '/ws')).toEqual({ path: '/ws/k/key', readable: true });
    expect(resolveSecretFilePath('../outside', '/ws').readable).toBe(false);
    expect(resolveSecretFilePath('a/../../outside', '/ws').readable).toBe(false);
  });
});
