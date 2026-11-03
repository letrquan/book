import { mkdtempSync, realpathSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { socketDirCandidates } from './messaging/socket-dir.js';
import { createEphemeralRewindEnvironment } from './rewind/environment.js';
import { checkTempRoot, trustedTempRoot } from './temp-root.js';

describe('checkTempRoot', () => {
  it('returns the startup root while the temp directory still resolves to it', () => {
    expect(checkTempRoot('/private/var/folders/x/T', '/private/var/folders/x/T', '/var/x/T')).toBe(
      '/private/var/folders/x/T',
    );
  });

  it('refuses a temp directory that now resolves somewhere else, naming both', () => {
    expect(() => checkTempRoot('/private/var/folders/x/T', '/work/redirected', '/var/x/T')).toThrow(
      /\/var\/x\/T: it resolves to \/work\/redirected, and it resolved to \/private\/var\/folders\/x\/T/,
    );
  });

  it('refuses a temp directory that no longer resolves, or never did', () => {
    expect(() => checkTempRoot('/private/var/folders/x/T', null, '/var/x/T')).toThrow(
      /no longer resolves/,
    );
    // Not re-resolved: a directory that only appears later may be one a sandboxed
    // command made, so the message says what to do rather than blaming a move.
    expect(() => checkTempRoot(null, '/private/var/folders/x/T', '/var/x/T')).toThrow(
      /\/var\/x\/T: it did not exist when Book started.*restart Book/,
    );
  });
});

/** The variables `os.tmpdir()` reads: TMPDIR on POSIX, TEMP and TMP on Windows. */
const TEMP_VARIABLES = ['TMPDIR', 'TEMP', 'TMP'] as const;

describe('trustedTempRoot', () => {
  const saved = Object.fromEntries(TEMP_VARIABLES.map((name) => [name, process.env[name]]));
  const scratch: string[] = [];

  afterEach(() => {
    for (const name of TEMP_VARIABLES) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
    for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true });
  });

  /** Point `os.tmpdir()` at a fresh directory, as a moved or replaced temp root would. */
  function moveTempDirectory(): string {
    const elsewhere = mkdtempSync(join(tmpdir(), 'book-temp-root-'));
    scratch.push(elsewhere);
    for (const name of TEMP_VARIABLES) process.env[name] = elsewhere;
    return elsewhere;
  }

  it('is the canonical temp directory Book started with', () => {
    expect(trustedTempRoot()).toBe(realpathSync(tmpdir()));
  });

  it('refuses once the temp directory resolves somewhere else', () => {
    const elsewhere = moveTempDirectory();

    expect(() => trustedTempRoot()).toThrow(/Refusing to create Book's temporary files/);
    expect(() => trustedTempRoot()).toThrow(realpathSync(elsewhere));
  });

  it('keeps a trusted entry from being created in a moved temp directory', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'book-temp-root-ws-'));
    scratch.push(workspace);
    moveTempDirectory();

    expect(() => createEphemeralRewindEnvironment(workspace)).toThrow(
      /Refusing to create Book's temporary files/,
    );
  });

  it("drops the inbox's temp fallback, and keeps its other candidates, once the temp root moved", () => {
    moveTempDirectory();

    // The other candidates are tried as before; without one, the refusal stands.
    expect(
      socketDirCandidates({ env: { BOOK_HOME: '/book-home' }, uid: 7, platform: 'linux' }).map(
        (candidate) => candidate.source,
      ),
    ).toEqual(['book-home']);
    expect(() => socketDirCandidates({ env: {}, uid: 7, platform: 'darwin' })).toThrow(
      /Refusing to create Book's temporary files/,
    );
  });
});
