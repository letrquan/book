import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { migrateLegacyPermissions } from './settings-loader.js';

let dir: string;
let fakeHome: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'book-migrate-'));
  fakeHome = mkdtempSync(join(tmpdir(), 'book-home-'));
  // Point os.homedir() at our fake home for these tests.
  vi.mock('os', async (orig) => ({
    ...((await orig()) as typeof import('os')),
    homedir: () => fakeHome,
  }));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  rmSync(fakeHome, { recursive: true, force: true });
  vi.doUnmock('os');
});

describe('migrateLegacyPermissions', () => {
  it('returns false when no legacy permissions.json exists', () => {
    expect(migrateLegacyPermissions(dir)).toBe(false);
  });

  it('returns false when legacy file has no rules', () => {
    mkdirSync(join(fakeHome, '.book'), { recursive: true });
    writeFileSync(join(fakeHome, '.book', 'permissions.json'), JSON.stringify({ rules: [] }));
    expect(migrateLegacyPermissions(dir)).toBe(false);
  });

  it('migrates allow/deny/ask rules into settings.local.json', () => {
    mkdirSync(join(fakeHome, '.book'), { recursive: true });
    writeFileSync(
      join(fakeHome, '.book', 'permissions.json'),
      JSON.stringify({
        rules: [
          { toolName: 'Bash', pattern: 'ls *', effect: 'allow' },
          { toolName: 'Bash', pattern: 'rm *', effect: 'deny' },
          { toolName: 'Bash', pattern: 'git push *', effect: 'ask' },
          { toolName: 'WebFetch', effect: 'allow' },
        ],
      }),
    );

    const migrated = migrateLegacyPermissions(dir);
    expect(migrated).toBe(true);

    const localPath = join(dir, '.book', 'settings.local.json');
    expect(existsSync(localPath)).toBe(true);

    const local = JSON.parse(readFileSync(localPath, 'utf-8'));
    expect(local.permissions.allow).toContain('Bash(ls *)');
    expect(local.permissions.deny).toContain('Bash(rm *)');
    expect(local.permissions.ask).toContain('Bash(git push *)');
    expect(local.permissions.allow).toContain('WebFetch');
  });

  it('preserves existing settings.local.json keys', () => {
    mkdirSync(join(fakeHome, '.book'), { recursive: true });
    writeFileSync(
      join(fakeHome, '.book', 'permissions.json'),
      JSON.stringify({
        rules: [{ toolName: 'Bash', pattern: 'ls', effect: 'allow' }],
      }),
    );
    mkdirSync(join(dir, '.book'), { recursive: true });
    writeFileSync(
      join(dir, '.book', 'settings.local.json'),
      JSON.stringify({
        model: 'existing-model',
        permissions: { allow: ['Read(*)'], ask: [], deny: [] },
      }),
    );

    migrateLegacyPermissions(dir);
    const local = JSON.parse(readFileSync(join(dir, '.book', 'settings.local.json'), 'utf-8'));
    expect(local.model).toBe('existing-model');
    expect(local.permissions.allow).toContain('Read(*)');
    expect(local.permissions.allow).toContain('Bash(ls)');
  });

  it('does not duplicate rules already migrated', () => {
    mkdirSync(join(fakeHome, '.book'), { recursive: true });
    writeFileSync(
      join(fakeHome, '.book', 'permissions.json'),
      JSON.stringify({
        rules: [{ toolName: 'Bash', pattern: 'ls', effect: 'allow' }],
      }),
    );

    migrateLegacyPermissions(dir);
    migrateLegacyPermissions(dir); // second run should not duplicate

    const local = JSON.parse(readFileSync(join(dir, '.book', 'settings.local.json'), 'utf-8'));
    const allowRules = local.permissions.allow.filter((r: string) => r === 'Bash(ls)');
    expect(allowRules.length).toBe(1);
  });

  it('returns false on corrupt legacy file (no crash)', () => {
    mkdirSync(join(fakeHome, '.book'), { recursive: true });
    writeFileSync(join(fakeHome, '.book', 'permissions.json'), '{not json');
    expect(migrateLegacyPermissions(dir)).toBe(false);
  });
});
