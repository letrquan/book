import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  AUTH_STORE_VERSION,
  clearCredentials,
  defaultAuthStorePath,
  deleteCredential,
  listCredentials,
  readAuthStore,
  readCredential,
  writeCredential,
} from './store.js';

let home: string;
let options: { home: string };

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'book-auth-store-'));
  options = { home };
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

function storeFile(): string {
  return defaultAuthStorePath(home);
}

describe('credential round trip', () => {
  it('stores and reads back an OAuth credential', () => {
    writeCredential(
      'anthropic',
      {
        kind: 'oauth',
        tokens: {
          accessToken: 'at',
          refreshToken: 'rt',
          expiresAt: 1000,
          account: 'a@example.com',
        },
      },
      { ...options, now: 500 },
    );

    const credential = readCredential('anthropic', options);
    expect(credential).toMatchObject({
      profile: 'anthropic',
      kind: 'oauth',
      createdAt: 500,
      updatedAt: 500,
      tokens: { accessToken: 'at', refreshToken: 'rt' },
    });
  });

  it('keeps createdAt across a re-login and moves updatedAt', () => {
    writeCredential(
      'codex',
      { kind: 'oauth', tokens: { accessToken: 'one' } },
      { ...options, now: 100 },
    );
    const updated = writeCredential(
      'codex',
      { kind: 'oauth', tokens: { accessToken: 'two' } },
      { ...options, now: 900 },
    );
    expect(updated.createdAt).toBe(100);
    expect(updated.updatedAt).toBe(900);
  });

  it('writes the store 0600', () => {
    writeCredential('anthropic', { kind: 'oauth', tokens: { accessToken: 'at' } }, options);
    if (process.platform === 'win32') return;
    expect(statSync(storeFile()).mode & 0o777).toBe(0o600);
  });

  it('re-asserts 0600 on a store that was loosened', () => {
    writeCredential('anthropic', { kind: 'oauth', tokens: { accessToken: 'at' } }, options);
    if (process.platform === 'win32') return;
    chmodSync(storeFile(), 0o644);
    writeCredential('anthropic', { kind: 'oauth', tokens: { accessToken: 'at2' } }, options);
    expect(statSync(storeFile()).mode & 0o777).toBe(0o600);
  });
});

describe('reads fail closed', () => {
  it('reports a missing store as missing, with no credentials', () => {
    const read = readAuthStore(options);
    expect(read.status).toBe('missing');
    expect(read.store.credentials).toEqual({});
  });

  it('treats malformed JSON as no credentials rather than throwing', () => {
    writeFileSync(storeFile(), '{ "version": ');
    const read = readAuthStore(options);
    expect(read.status).toBe('unreadable');
    expect(read.store.credentials).toEqual({});
    expect(readCredential('anthropic', options)).toBeUndefined();
  });

  it('treats an unknown store version as unreadable', () => {
    writeFileSync(storeFile(), JSON.stringify({ version: 99, credentials: {} }));
    expect(readAuthStore(options).status).toBe('unreadable');
  });

  it('does not quote the offending value, which would be a token', () => {
    writeFileSync(
      storeFile(),
      JSON.stringify({
        version: AUTH_STORE_VERSION,
        credentials: { anthropic: { kind: 'oauth', profile: 'anthropic', createdAt: 'nope' } },
      }),
    );
    const read = readAuthStore(options);
    expect(read.status).toBe('unreadable');
    if (read.status === 'unreadable') expect(read.error).not.toContain('nope');
  });
});

describe('writes refuse a store they could not parse', () => {
  it('throws rather than overwriting, so a refresh token is not lost', () => {
    writeFileSync(storeFile(), 'not json at all');
    expect(() =>
      writeCredential('anthropic', { kind: 'oauth', tokens: { accessToken: 'at' } }, options),
    ).toThrow(/unreadable/);
    expect(readFileSync(storeFile(), 'utf-8')).toBe('not json at all');
  });
});

describe('removal', () => {
  it('deletes one credential and leaves the rest', () => {
    writeCredential('anthropic', { kind: 'oauth', tokens: { accessToken: 'a' } }, options);
    writeCredential('codex', { kind: 'oauth', tokens: { accessToken: 'b' } }, options);
    expect(deleteCredential('anthropic', options)).toBe(true);
    expect(readCredential('anthropic', options)).toBeUndefined();
    expect(readCredential('codex', options)).toBeDefined();
  });

  it('reports a no-op for a profile that was never stored', () => {
    expect(deleteCredential('codex', options)).toBe(false);
  });

  it('clears every credential', () => {
    writeCredential('anthropic', { kind: 'oauth', tokens: { accessToken: 'a' } }, options);
    writeCredential('codex', { kind: 'oauth', tokens: { accessToken: 'b' } }, options);
    expect(clearCredentials(options)).toBe(2);
    expect(listCredentials(options)).toEqual([]);
  });
});

describe('listCredentials', () => {
  it('never returns a token or an API key', () => {
    writeCredential(
      'anthropic',
      {
        kind: 'oauth',
        tokens: { accessToken: 'secret-at', refreshToken: 'secret-rt', account: 'a@b.c' },
      },
      options,
    );
    writeCredential('legacy', { kind: 'api-key', apiKey: 'sk-secret' }, options);

    const listed = listCredentials(options);
    const serialized = JSON.stringify(listed);
    expect(serialized).not.toContain('secret-at');
    expect(serialized).not.toContain('secret-rt');
    expect(serialized).not.toContain('sk-secret');
    expect(listed.map((c) => c.profile)).toEqual(['anthropic', 'legacy']);
    expect(listed[0]).toMatchObject({ account: 'a@b.c', refreshable: true });
    expect(listed[1]).toMatchObject({ kind: 'api-key', refreshable: false });
  });
});
