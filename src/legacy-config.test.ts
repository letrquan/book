import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { loadConfig } from './config.js';
import { parseLegacyConfig, readLegacyBaseUrl } from './legacy-config.js';
import { legacyBaseUrlFingerprint } from './provider-approvals.js';

let workspace: string;
let home: string;

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'book-legacy-config-'));
  home = mkdtempSync(join(tmpdir(), 'book-legacy-home-'));
  mkdirSync(join(workspace, '.book'));
  vi.stubEnv('BOOK_HOME', home);
  vi.stubEnv('BOOK_API_KEY', 'test-key');
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(workspace, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

const writeLegacy = (value: unknown) =>
  writeFileSync(join(workspace, '.bookrc.json'), JSON.stringify(value));

// Finding 10: `book trust provider .bookrc.json` and the loader must fingerprint the same string.
describe('the legacy .bookrc.json parser', () => {
  it('is absent when there is no file', () => {
    expect(parseLegacyConfig(workspace)).toBeNull();
    expect(readLegacyBaseUrl(workspace)).toBeUndefined();
  });

  it('returns the baseUrl exactly as written: no trimming, no URL rewriting', () => {
    writeLegacy({ baseUrl: 'https://Repo.Example:443/v1/' });
    expect(readLegacyBaseUrl(workspace)).toBe('https://Repo.Example:443/v1/');
  });

  it.each([
    ['not a URL', { baseUrl: 'not a url' }],
    ['not a string', { baseUrl: 3 }],
    ['an invalid sibling key', { baseUrl: 'https://a.example', maxTurns: 'many' }],
  ])('reads no baseUrl when the file is invalid (%s), as the loader refuses it', (_name, value) => {
    writeLegacy(value);
    expect(readLegacyBaseUrl(workspace)).toBeUndefined();
    expect(() => loadConfig(workspace, { allowMissingApiKey: true })).toThrow();
  });

  it('reads no baseUrl from a file that is not JSON', () => {
    writeFileSync(join(workspace, '.bookrc.json'), '{ nope');
    expect(readLegacyBaseUrl(workspace)).toBeUndefined();
    expect(() => parseLegacyConfig(workspace)).toThrow('Invalid JSON in config file');
  });

  it('agrees with the loader on the URL it gates', () => {
    for (const baseUrl of [' http://x.example/v1 ', 'localhost:1234', 'https://repo.example/v1']) {
      writeLegacy({ baseUrl });
      const gate = loadConfig(workspace, { allowMissingApiKey: true }).workspaceProviderGate;
      expect(gate?.legacyBaseUrl?.baseUrl).toBe(readLegacyBaseUrl(workspace));
      expect(legacyBaseUrlFingerprint(gate!.legacyBaseUrl!.baseUrl)).toBe(
        legacyBaseUrlFingerprint(readLegacyBaseUrl(workspace)!),
      );
    }
  });
});
